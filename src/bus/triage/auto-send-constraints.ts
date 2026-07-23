export interface PropertyConstraints {
  hasResidentManager: boolean;
  propertyAddress: string;
}

export interface AutoSendConstraintResult {
  allowed: boolean;
  reason: string;
  rule: string;
}

export function checkAutoSendConstraints(property: PropertyConstraints): AutoSendConstraintResult {
  if (property.hasResidentManager) {
    return {
      allowed: false,
      reason: `Property ${property.propertyAddress} has a resident manager — auto-send denied`,
      rule: 'resident-manager-deny',
    };
  }

  return {
    allowed: true,
    reason: 'No property-level auto-send constraints',
    rule: 'property-clear',
  };
}
