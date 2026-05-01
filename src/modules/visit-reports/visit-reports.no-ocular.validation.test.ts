import { describe, expect, it } from 'vitest';
import { ServiceType } from '../../utils/constants.js';
import { __visitReportServiceInternals } from './visit-reports.service.js';

describe('visit report no-ocular completeness validation', () => {
  it('rejects incomplete consultation data', () => {
    const missing = __visitReportServiceInternals.getIncompleteNoOcularFields({
      title: '',
      serviceType: '',
      discussionNotes: '',
      customerRequirements: '',
      notes: '',
    });

    expect(missing).toContain('project title or service details');
    expect(missing).toContain('project description or requirement notes');
    expect(missing).toContain('measurements/dimensions');
    expect(missing).toContain('material preference');
    expect(missing).toContain('design/reference details');
    expect(missing).toContain('uploaded reference files/images');
  });

  it('accepts complete consultation data using existing fields', () => {
    const missing = __visitReportServiceInternals.getIncompleteNoOcularFields({
      title: 'Gate Fabrication',
      serviceType: ServiceType.CUSTOM,
      serviceTypeCustom: 'Gate Fabrication',
      discussionNotes: 'Customer wants powder-coated gate and approved specs.',
      customerRequirements: 'Need gate fabrication with matching side panel.',
      notes: 'No ocular required. Ready for project details.',
      lineItems: [
        {
          label: 'Gate panel',
          quantity: 1,
          length: 200,
          width: 20,
          height: 180,
          thickness: 2,
          area: 36000,
          notes: 'Use stainless profile.',
        },
      ],
      materials: 'Stainless steel',
      preferredDesign: 'Modern horizontal bars',
      photoKeys: ['visit-reports/photos/gate-1.jpg'],
      referenceImageKeys: ['visit-reports/reference/design-1.jpg'],
    });

    expect(missing).toEqual([]);
  });
});
