import { getPaseoPool } from './pool';
import type {
  ArBalance,
  CallerInfo,
  ContactType,
  OccupancyStatus,
  PhoneCallerContext,
  WorkOrderPriority,
  WorkOrderStatus,
  WorkOrderSummary,
} from './types';

// ---------------------------------------------------------------------------
// Caller identification
// ---------------------------------------------------------------------------

/**
 * Resolve a phone number (E.164) to a Paseo contact.
 * Matches primary_phone_e164 first, falls back to the all_phones array.
 * For tenants, includes their active/notice occupancy, unit, and property.
 * Returns null if no contact matches.
 */
export async function lookupCaller(phoneE164: string): Promise<CallerInfo | null> {
  const pool = getPaseoPool();
  const { rows } = await pool.query<{
    contact_id: string;
    display_name: string;
    primary_phone_e164: string;
    contact_type: string;
    occupancy_id: string | null;
    unit_id: string | null;
    unit_name: string | null;
    property_id: string | null;
    property_name: string | null;
    property_address: string | null;
    appfolio_property_id: string | null;
    occupancy_status: string | null;
    rent: string | null;
    lease_from: string | null;
    lease_to: string | null;
  }>(
    `
    SELECT
      c.id                    AS contact_id,
      c.display_name,
      c.primary_phone_e164,
      c.contact_type::text    AS contact_type,
      o.id                    AS occupancy_id,
      o.unit_id,
      u.unit_name,
      p.id                    AS property_id,
      p.name                  AS property_name,
      p.address_full          AS property_address,
      p.appfolio_property_id,
      o.status::text          AS occupancy_status,
      o.rent,
      o.lease_from::text,
      o.lease_to::text
    FROM contacts c
    LEFT JOIN occupancies o
      ON o.primary_tenant_id = c.id
      AND o.status IN ('current', 'notice')
    LEFT JOIN units u ON u.id = o.unit_id
    LEFT JOIN properties p ON p.id = u.property_id
    WHERE c.primary_phone_e164 = $1
       OR $1 = ANY(c.all_phones)
    ORDER BY
      CASE o.status::text
        WHEN 'current' THEN 0
        WHEN 'notice'  THEN 1
        ELSE 2
      END,
      o.lease_from DESC NULLS LAST
    LIMIT 1
    `,
    [phoneE164],
  );

  if (rows.length === 0) return null;
  const r = rows[0];

  const caller: CallerInfo = {
    contactId: r.contact_id,
    displayName: r.display_name ?? 'Unknown',
    phoneE164: r.primary_phone_e164 ?? phoneE164,
    contactType: (r.contact_type ?? 'tenant') as ContactType,
  };

  if (r.occupancy_id && r.unit_id) {
    caller.occupancy = {
      occupancyId: r.occupancy_id,
      unitId: r.unit_id,
      unitName: r.unit_name ?? '',
      propertyId: r.property_id ?? '',
      propertyName: r.property_name ?? '',
      propertyAddress: r.property_address ?? '',
      appfolioPropertyId: r.appfolio_property_id,
      status: (r.occupancy_status ?? 'current') as OccupancyStatus,
      rentCents: r.rent ? Math.round(parseFloat(r.rent) * 100) : null,
      leaseFrom: r.lease_from,
      leaseTo: r.lease_to,
    };
  }

  return caller;
}

// ---------------------------------------------------------------------------
// Work orders
// ---------------------------------------------------------------------------

/**
 * Return open/in-progress work orders for a Supabase unit UUID.
 * Sorted by priority (critical first) then creation date.
 */
export async function getOpenWorkOrders(unitId: string): Promise<WorkOrderSummary[]> {
  const pool = getPaseoPool();
  const { rows } = await pool.query<{
    id: string;
    work_order_number: string | null;
    job_description: string | null;
    work_order_issue: string | null;
    status: string;
    priority: string;
    vendor_trade: string | null;
    assigned_user: string | null;
    created_at_appfolio: string | null;
    scheduled_start: string | null;
  }>(
    `
    SELECT
      id,
      work_order_number,
      job_description,
      work_order_issue,
      status::text,
      priority::text,
      vendor_trade,
      assigned_user,
      created_at_appfolio::text,
      scheduled_start::text
    FROM work_orders
    WHERE unit_id = $1
      AND status NOT IN ('completed', 'canceled')
    ORDER BY
      CASE priority::text
        WHEN 'critical'   THEN 0
        WHEN 'high'       THEN 1
        WHEN 'normal'     THEN 2
        WHEN 'low'        THEN 3
        ELSE 4
      END,
      created_at_appfolio DESC NULLS LAST
    LIMIT 10
    `,
    [unitId],
  );

  return rows.map((r) => ({
    id: r.id,
    workOrderNumber: r.work_order_number,
    jobDescription: r.job_description,
    issueDescription: r.work_order_issue,
    status: r.status as WorkOrderStatus,
    priority: r.priority as WorkOrderPriority,
    vendorTrade: r.vendor_trade,
    assignedUser: r.assigned_user,
    createdAtAppfolio: r.created_at_appfolio,
    scheduledStart: r.scheduled_start,
  }));
}

// ---------------------------------------------------------------------------
// AR balance
// ---------------------------------------------------------------------------

/**
 * Return the total outstanding balance and open charge count for a unit.
 * Uses tenant_charges.is_open and open_amount (pre-computed by AppFolio sync).
 */
export async function getArBalance(unitId: string): Promise<ArBalance> {
  const pool = getPaseoPool();
  const { rows } = await pool.query<{
    balance_total: string | null;
    open_charge_count: string | null;
  }>(
    `
    SELECT
      SUM(open_amount)::text          AS balance_total,
      COUNT(*)::text                  AS open_charge_count
    FROM tenant_charges
    WHERE unit_id = $1
      AND is_open = true
    `,
    [unitId],
  );

  const r = rows[0];
  return {
    balanceCents: r?.balance_total ? Math.round(parseFloat(r.balance_total) * 100) : 0,
    openChargeCount: r?.open_charge_count ? parseInt(r.open_charge_count, 10) : 0,
  };
}

// ---------------------------------------------------------------------------
// Combined context pull (all lookups in one call)
// ---------------------------------------------------------------------------

/**
 * Full phone caller context: caller identity + open WOs + AR balance.
 * Returns null if the phone number is not in Paseo's contact database.
 * This is the primary function the phone agent calls on inbound events.
 */
export async function getCallerContext(phoneE164: string): Promise<PhoneCallerContext | null> {
  const caller = await lookupCaller(phoneE164);
  if (!caller) return null;

  const unitId = caller.occupancy?.unitId;

  const [openWorkOrders, arBalance] = await Promise.all([
    unitId ? getOpenWorkOrders(unitId) : Promise.resolve([]),
    unitId ? getArBalance(unitId) : Promise.resolve({ balanceCents: 0, openChargeCount: 0 }),
  ]);

  return { caller, openWorkOrders, arBalance };
}
