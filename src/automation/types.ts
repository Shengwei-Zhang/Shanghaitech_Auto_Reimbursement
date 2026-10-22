export interface RuntimeInputs {
  reimbursementPurpose: string;
  reimbursementReason: string;
  attachmentCount: string;
  payeePersonCode: string;
}

export interface DebugStatePaths {
  htmlPath: string;
  jsonPath: string;
  ariaPath: string;
}

export interface Point {
  x: number;
  y: number;
}
