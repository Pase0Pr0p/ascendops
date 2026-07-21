export interface VerificationInputs {
  redirectedToSr: boolean;
  firstLog: string;
  woNumber: string;
  descOnPage: string;
  submittedDescription: string;
  propOnPage: string;
  prioOnPage: string;
  submittedPriority: string;
  pteOnPage: string;
  submittedPte: string;
}

export interface VerificationResult {
  verified: boolean;
  fields_verified: {
    description: boolean;
    property_present: boolean;
    priority: boolean | null;
    permission_to_enter: boolean | null;
    unit: null;
  };
}

const PTE_MAP: Record<string, string> = {
  'true': 'yes',
  'false': 'no',
  'not_applicable': 'not applicable',
};

export function computeCreateWoVerified(inputs: VerificationInputs): VerificationResult {
  const hasCreatedPhrase = /Created/i.test(inputs.firstLog);
  const hasConcreteWoId = /WO[- ]?\d+|\d{4,}/.test(inputs.woNumber.trim());

  const descFirstWords = inputs.submittedDescription.trim().split(/\s+/).slice(0, 3).join(' ').toLowerCase();
  const descriptionMatches = descFirstWords.length > 0 && inputs.descOnPage.toLowerCase().includes(descFirstWords);

  const propLower = inputs.propOnPage.toLowerCase();
  const propertyPresent = propLower.length > 0;

  const prioLower = inputs.prioOnPage.toLowerCase();
  const priorityExposed = prioLower.length > 0;
  const priorityMatches = priorityExposed && prioLower.includes((inputs.submittedPriority || 'Normal').toLowerCase());

  const pteLower = inputs.pteOnPage.toLowerCase();
  const expectedPteLabel = PTE_MAP[inputs.submittedPte] ?? '';
  const pteExposed = pteLower.length > 0 && expectedPteLabel.length > 0;
  const pteMatches = pteExposed && pteLower.includes(expectedPteLabel);

  const fields_verified = {
    description: descriptionMatches,
    property_present: propertyPresent,
    priority: priorityExposed ? priorityMatches : null,
    permission_to_enter: pteExposed ? pteMatches : null,
    unit: null as null,
  };

  const allExposedFieldsMatch =
    descriptionMatches &&
    propertyPresent &&
    (fields_verified.priority === null || fields_verified.priority) &&
    (fields_verified.permission_to_enter === null || fields_verified.permission_to_enter);

  return {
    verified: inputs.redirectedToSr && hasCreatedPhrase && hasConcreteWoId && allExposedFieldsMatch,
    fields_verified,
  };
}
