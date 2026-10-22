import { test, expect } from '@playwright/test';
import { canonicalStep, CANONICAL_STEPS } from '../src/automation/runner';
import { classifyResumeState } from '../src/automation/resume';
import { selectFirstMissingInvoice } from '../src/automation/invoice-pdf';

test('legacy START_FROM labels resolve to semantic stages', () => {
  expect(canonicalStep(' upload invoice file ')).toBe('attach invoice');
  expect(canonicalStep('confirm payment')).toBe('configure payment');
  expect(canonicalStep('click advance')).toBe('prepare submission');
  expect(CANONICAL_STEPS).toContain('save reimbursement');
});

test('resume state prioritizes attached and populated invoice states', () => {
  const base = {
    invoiceAttached: false,
    addInvoicePopulated: false,
    addInvoiceDialogVisible: false,
    invoicePickerOpen: false,
    fundingEditorVisible: true,
    url: 'https://sapbpm-new.shanghaitech.edu.cn/bpm-new/rbReimbursement/showLoadRbReimbursement.job',
  };

  expect(classifyResumeState({ ...base, invoiceAttached: true })).toBe('configure payment');
  expect(classifyResumeState({
    ...base,
    addInvoicePopulated: true,
    invoicePickerOpen: true,
  })).toBe('attach invoice');
  expect(classifyResumeState(base)).toBe('select funding item');
});

test('PDF candidate selection keeps order and skips existing invoice numbers', () => {
  const candidates = [
    { filePath: '01.pdf', invoiceNumber: '26117000000774404378' },
    { filePath: '02.pdf', invoiceNumber: '26117000000774404386' },
    { filePath: '03.pdf', invoiceNumber: '26317000001920913323' },
  ];

  expect(selectFirstMissingInvoice(candidates, [
    '26117000000774404378',
    '26117000000774404386',
  ])).toEqual(candidates[2]);
  expect(selectFirstMissingInvoice(candidates, candidates.map((item) => item.invoiceNumber))).toBeNull();
});

