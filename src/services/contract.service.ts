import PDFDocument from 'pdfkit';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import { r2Client } from '../config/r2.js';
import { env } from '../config/env.js';
import { formatCurrency } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

/**
 * Download a file from R2 as a Buffer (used for embedding images in PDFs)
 */
async function downloadR2Buffer(key: string): Promise<Buffer | null> {
  try {
    const command = new GetObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: key,
    });
    const response = await r2Client.send(command);
    if (!response.Body) return null;
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (err) {
    logger.warn(`Failed to download R2 file ${key} for contract embedding`, err);
    return null;
  }
}

export interface ContractData {
  projectTitle: string;
  projectDescription: string;
  siteAddress: string;
  serviceType: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  customerAddress?: string;
  engineerNames: string[];
  totalAmount: number;
  paymentType: 'full' | 'installment';
  stages: { label: string; percentage: number; amount: number }[];
  estimatedDuration?: string;
  materialType?: string;
  finishColor?: string;
  quantity: number;
  customerSignatureKey?: string | null;
  lineItems?: { label: string; length?: number; width?: number; height?: number; quantity?: number; notes?: string }[];
  measurementUnit?: string;
}

/**
 * Generate a 15-section SERVICE CONTRACT PDF, return as Buffer
 */
export async function generateContractPdf(
  data: ContractData,
  watermark: 'ORIGINAL' | 'COPY',
): Promise<Buffer> {
  let signatureBuffer: Buffer | null = null;
  if (data.customerSignatureKey) {
    signatureBuffer = await downloadR2Buffer(data.customerSignatureKey);
  }

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: {
          Title: `Service Contract — ${data.projectTitle} (${watermark})`,
          Author: 'RMV Stainless Steel Fabrication',
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
      const left = 50;
      const contentWidth = pageWidth - 100;

      // ── Diagonal Watermark ──
      doc.save();
      doc.rotate(45, { origin: [pageWidth / 2, pageHeight / 2] });
      doc.fontSize(72).font('Helvetica-Bold').fillColor('#000000').opacity(0.06)
        .text(watermark, 0, pageHeight / 2 - 36, { width: pageWidth * 1.4, align: 'center' });
      doc.restore();
      doc.opacity(1);

      // ── Header ──
      doc.fontSize(18).font('Helvetica-Bold').fillColor('#1a1a1a')
        .text('RMV STAINLESS STEEL FABRICATION', { align: 'center' });
      doc.fontSize(9).font('Helvetica').fillColor('#555555')
        .text('Malabon City, Metro Manila, Philippines', { align: 'center' }).moveDown(0.3);
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#1a1a1a')
        .text('SERVICE CONTRACT', { align: 'center' }).moveDown(0.3);
      doc.fontSize(9).font('Helvetica').fillColor('#888888')
        .text(`Date: ${new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Manila' })}`, { align: 'center' })
        .moveDown(1);
      drawLine(doc);
      doc.moveDown(0.5);

      // ── Section 1: Parties ──
      sectionHeader(doc, '1. PARTIES');
      paragraph(doc, `This Service Contract ("Contract") is entered into by and between:`, left, contentWidth);
      doc.moveDown(0.3);
      field(doc, 'Service Provider', 'RMV Stainless Steel Fabrication', left);
      field(doc, 'Address', 'Malabon City, Metro Manila, Philippines', left);
      doc.moveDown(0.3);
      field(doc, 'Client', data.customerName, left);
      field(doc, 'Email', data.customerEmail, left);
      if (data.customerPhone) field(doc, 'Phone', data.customerPhone, left);
      if (data.customerAddress) field(doc, 'Address', data.customerAddress, left);
      sectionEnd(doc);

      // ── Section 2: Scope of Work ──
      sectionHeader(doc, '2. SCOPE OF WORK');
      paragraph(doc, 'The Service Provider agrees to perform the following fabrication services:', left, contentWidth);
      doc.moveDown(0.3);
      field(doc, 'Project Title', data.projectTitle, left);
      field(doc, 'Service Type', data.serviceType.replace(/_/g, ' ').toUpperCase(), left);
      field(doc, 'Description', data.projectDescription, left);
      field(doc, 'Site/Delivery Address', data.siteAddress, left);
      if (data.materialType) field(doc, 'Material Type', data.materialType, left);
      if (data.finishColor) field(doc, 'Finish/Color', data.finishColor, left);
      field(doc, 'Quantity', String(data.quantity), left);
      if (data.lineItems && data.lineItems.length > 0) {
        doc.moveDown(0.3);
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#333333').text('Line Items:', left);
        doc.moveDown(0.2);
        for (const item of data.lineItems) {
          const dims = [item.length, item.width, item.height].filter(Boolean).join(' x ');
          const unit = data.measurementUnit || 'cm';
          doc.fontSize(9).font('Helvetica').fillColor('#333333')
            .text(`  - ${item.label}${dims ? ` (${dims} ${unit})` : ''}${item.quantity && item.quantity > 1 ? ` x${item.quantity}` : ''}${item.notes ? ` — ${item.notes}` : ''}`, left + 10);
          doc.moveDown(0.1);
        }
      }
      sectionEnd(doc);

      // ── Section 3: Contract Price ──
      sectionHeader(doc, '3. CONTRACT PRICE');
      field(doc, 'Total Contract Amount', formatCurrency(data.totalAmount), left);
      field(doc, 'Payment Type', data.paymentType === 'full' ? 'Full Payment' : 'Installment Plan', left);
      paragraph(doc, 'The above amount covers all materials, labor, and fabrication costs as outlined in the approved blueprint and quotation.', left, contentWidth);
      sectionEnd(doc);

      // ── Section 4: Payment Terms ──
      sectionHeader(doc, '4. PAYMENT TERMS');
      paragraph(doc, 'The Client agrees to make payments according to the following schedule:', left, contentWidth);
      doc.moveDown(0.3);
      for (const stage of data.stages) {
        doc.fontSize(9).font('Helvetica').fillColor('#333333')
          .text(`  - ${stage.label} — ${stage.percentage}% — ${formatCurrency(stage.amount)}`, left + 10);
        doc.moveDown(0.15);
      }
      doc.moveDown(0.3);
      bullet(doc, 'All payments shall be made via the methods provided in the system (GCash, Bank Transfer, QRPH, or Cash).', left, contentWidth);
      bullet(doc, 'The project timeline begins upon receipt of the first payment.', left, contentWidth);
      bullet(doc, 'Failure to make payments on schedule may result in work suspension.', left, contentWidth);
      sectionEnd(doc);

      // ── Section 5: Project Timeline ──
      sectionHeader(doc, '5. PROJECT TIMELINE');
      if (data.estimatedDuration) {
        field(doc, 'Estimated Duration', data.estimatedDuration, left);
      }
      paragraph(doc, 'The estimated timeline begins upon receipt of the initial payment and is subject to change based on material availability, design complexity, and site conditions. The Service Provider will notify the Client of any significant delays.', left, contentWidth);
      sectionEnd(doc);

      // ── Section 6: Materials & Specifications ──
      sectionHeader(doc, '6. MATERIALS & SPECIFICATIONS');
      paragraph(doc, 'All materials used shall be of standard quality unless otherwise specified. The Service Provider shall use the materials and specifications as agreed in the approved blueprint and quotation.', left, contentWidth);
      if (data.materialType) field(doc, 'Primary Material', data.materialType, left);
      if (data.finishColor) field(doc, 'Finish/Color', data.finishColor, left);
      sectionEnd(doc);

      // New page for remaining sections
      doc.addPage();

      // Watermark on new page
      doc.save();
      doc.rotate(45, { origin: [pageWidth / 2, pageHeight / 2] });
      doc.fontSize(72).font('Helvetica-Bold').fillColor('#000000').opacity(0.06)
        .text(watermark, 0, pageHeight / 2 - 36, { width: pageWidth * 1.4, align: 'center' });
      doc.restore();
      doc.opacity(1);

      // ── Section 7: Change Orders ──
      sectionHeader(doc, '7. CHANGE ORDERS');
      paragraph(doc, 'Any modifications to the scope of work, materials, or design after blueprint approval shall be documented as a Change Order. Change orders may result in additional charges and timeline adjustments, which must be agreed upon by both parties before implementation.', left, contentWidth);
      sectionEnd(doc);

      // ── Section 8: Warranty ──
      sectionHeader(doc, '8. WARRANTY');
      paragraph(doc, 'The Service Provider warrants all fabricated items against manufacturing defects for a period of one (1) year from the date of completion and delivery, under normal use conditions. This warranty does not cover:', left, contentWidth);
      doc.moveDown(0.2);
      bullet(doc, 'Damage caused by misuse, abuse, or negligence', left, contentWidth);
      bullet(doc, 'Normal wear and tear', left, contentWidth);
      bullet(doc, 'Modifications made by third parties', left, contentWidth);
      bullet(doc, 'Environmental damage (e.g., excessive moisture, chemical exposure)', left, contentWidth);
      sectionEnd(doc);

      // ── Section 9: Liability ──
      sectionHeader(doc, '9. LIABILITY');
      paragraph(doc, 'The Service Provider shall not be held liable for any indirect, incidental, or consequential damages arising from the use of the fabricated items. The Service Provider\'s total liability shall not exceed the total contract amount. The Client is responsible for ensuring that the installation site meets all necessary safety and structural requirements.', left, contentWidth);
      sectionEnd(doc);

      // ── Section 10: Force Majeure ──
      sectionHeader(doc, '10. FORCE MAJEURE');
      paragraph(doc, 'Neither party shall be liable for delays or failure to perform obligations due to events beyond their reasonable control, including but not limited to: natural disasters, war, pandemic, government restrictions, labor disputes, or supply chain disruptions. The affected party shall notify the other party within a reasonable timeframe.', left, contentWidth);
      sectionEnd(doc);

      // ── Section 11: Cancellation & Refund ──
      sectionHeader(doc, '11. CANCELLATION & REFUND POLICY');
      bullet(doc, 'If the Client cancels before fabrication begins, a partial refund may be issued less any costs already incurred for materials and planning.', left, contentWidth);
      bullet(doc, 'If the Client cancels after fabrication has begun, no refund shall be issued for work already completed.', left, contentWidth);
      bullet(doc, 'The Service Provider reserves the right to cancel the project if the Client fails to meet payment obligations, subject to written notice.', left, contentWidth);
      sectionEnd(doc);

      // ── Section 12: Confidentiality ──
      sectionHeader(doc, '12. CONFIDENTIALITY');
      paragraph(doc, 'Both parties agree to keep confidential all information exchanged during the course of this project, including but not limited to: blueprints, designs, pricing, and personal information. This obligation survives the termination of this contract.', left, contentWidth);
      sectionEnd(doc);

      // ── Section 13: Dispute Resolution ──
      sectionHeader(doc, '13. DISPUTE RESOLUTION');
      paragraph(doc, 'Any disputes arising from this contract shall first be resolved through good-faith negotiation between the parties. If a resolution cannot be reached, the dispute shall be submitted to mediation or arbitration in accordance with the laws of the Republic of the Philippines. The venue for any legal proceedings shall be the courts of Metro Manila.', left, contentWidth);
      sectionEnd(doc);

      // ── Section 14: Entire Agreement ──
      sectionHeader(doc, '14. ENTIRE AGREEMENT');
      paragraph(doc, 'This contract, together with the approved blueprint and quotation, constitutes the entire agreement between the parties. No verbal or written modifications shall be binding unless signed by both parties. This contract supersedes all prior negotiations, representations, or agreements relating to this subject matter.', left, contentWidth);
      sectionEnd(doc);

      // ── Section 15: Signatures ──
      sectionHeader(doc, '15. SIGNATURES');
      paragraph(doc, 'By signing below, both parties acknowledge that they have read, understood, and agree to all terms and conditions stated in this Service Contract.', left, contentWidth);
      doc.moveDown(0.5);

      const sigY = doc.y + 10;
      const colWidth = (pageWidth - 100) / 2;

      // Customer signature
      doc.fontSize(9).font('Helvetica').fillColor('#555555').text('Client:', left, sigY);
      if (signatureBuffer) {
        try {
          doc.image(signatureBuffer, left, sigY + 14, { width: colWidth - 40, height: 30, fit: [colWidth - 40, 30] });
        } catch { /* fallback to blank line */ }
      }
      doc.y = sigY + 50;
      drawLine(doc, left, left + colWidth - 20);
      doc.fontSize(9).text(data.customerName, left, doc.y + 5);
      doc.fontSize(8).fillColor('#888888').text('Date: ____________________', left, doc.y + 4);

      // Company signature
      doc.fontSize(9).fillColor('#555555').text('Service Provider:', left + colWidth + 20, sigY);
      doc.y = sigY + 50;
      drawLine(doc, left + colWidth + 20, pageWidth - 50);
      doc.fontSize(9).fillColor('#1a1a1a').text('Authorized Representative', left + colWidth + 20, doc.y + 5);
      doc.fontSize(8).fillColor('#888888').text('RMV Stainless Steel Fabrication', left + colWidth + 20, doc.y + 4);
      doc.text('Date: ____________________', left + colWidth + 20, doc.y + 4);

      // ── Footer ──
      doc.moveDown(2);
      doc.fontSize(7).font('Helvetica').fillColor('#999999')
        .text(
          `This is a system-generated contract document. ${watermark} copy. Generated on ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}`,
          { align: 'center' },
        );

      doc.end();
    } catch (error) {
      logger.error('Failed to generate contract PDF', error);
      reject(error);
    }
  });
}

/**
 * Generate both ORIGINAL and COPY contract PDFs, upload to R2, return keys
 */
export async function generateAndUploadContract(
  data: ContractData,
): Promise<{ originalKey: string; copyKey: string }> {
  const [originalBuf, copyBuf] = await Promise.all([
    generateContractPdf(data, 'ORIGINAL'),
    generateContractPdf(data, 'COPY'),
  ]);

  const id = uuidv4();
  const originalKey = `contracts/${id}-original.pdf`;
  const copyKey = `contracts/${id}-copy.pdf`;

  await Promise.all([
    r2Client.send(
      new PutObjectCommand({
        Bucket: env.R2_BUCKET_NAME,
        Key: originalKey,
        Body: originalBuf,
        ContentType: 'application/pdf',
      }),
    ),
    r2Client.send(
      new PutObjectCommand({
        Bucket: env.R2_BUCKET_NAME,
        Key: copyKey,
        Body: copyBuf,
        ContentType: 'application/pdf',
      }),
    ),
  ]);

  logger.info(`Contract PDFs uploaded: ${originalKey}, ${copyKey}`);

  return { originalKey, copyKey };
}

// ── Helpers ──

function drawLine(doc: PDFKit.PDFDocument, fromX?: number, toX?: number) {
  const y = doc.y;
  doc
    .strokeColor('#dddddd')
    .lineWidth(0.5)
    .moveTo(fromX ?? 50, y)
    .lineTo(toX ?? doc.page.width - 50, y)
    .stroke();
}

function sectionHeader(doc: PDFKit.PDFDocument, title: string) {
  doc
    .fontSize(11)
    .font('Helvetica-Bold')
    .fillColor('#1a1a1a')
    .text(title);
  doc.moveDown(0.3);
}

function field(doc: PDFKit.PDFDocument, label: string, value: string, x: number) {
  doc
    .fontSize(9)
    .font('Helvetica-Bold')
    .fillColor('#555555')
    .text(`${label}:`, x, undefined, { continued: true });
  doc
    .font('Helvetica')
    .fillColor('#1a1a1a')
    .text(`  ${value}`);
  doc.moveDown(0.15);
}

function paragraph(doc: PDFKit.PDFDocument, text: string, x: number, width: number) {
  doc.fontSize(9).font('Helvetica').fillColor('#333333').text(text, x, undefined, { width });
  doc.moveDown(0.2);
}

function bullet(doc: PDFKit.PDFDocument, text: string, x: number, width: number) {
  doc.fontSize(9).font('Helvetica').fillColor('#333333').text(`  •  ${text}`, x, undefined, { width: width - 10 });
  doc.moveDown(0.15);
}

function sectionEnd(doc: PDFKit.PDFDocument) {
  doc.moveDown(0.4);
  drawLine(doc);
  doc.moveDown(0.4);
}
