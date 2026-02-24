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
}

/**
 * Generate a contract PDF with a watermark, return as Buffer
 */
export async function generateContractPdf(
  data: ContractData,
  watermark: 'ORIGINAL' | 'COPY',
): Promise<Buffer> {
  // Pre-download customer signature from R2 if available
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
          Title: `Contract — ${data.projectTitle} (${watermark})`,
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

      // ── Diagonal Watermark ──
      doc.save();
      doc.rotate(45, { origin: [pageWidth / 2, pageHeight / 2] });
      doc
        .fontSize(72)
        .font('Helvetica-Bold')
        .fillColor('#000000')
        .opacity(0.06)
        .text(watermark, 0, pageHeight / 2 - 36, {
          width: pageWidth * 1.4,
          align: 'center',
        });
      doc.restore();
      doc.opacity(1);

      // ── Header ──
      doc
        .fontSize(18)
        .font('Helvetica-Bold')
        .fillColor('#1a1a1a')
        .text('RMV STAINLESS STEEL FABRICATION', { align: 'center' });

      doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor('#555555')
        .text('Malabon City, Metro Manila, Philippines', { align: 'center' })
        .moveDown(0.3);

      doc
        .fontSize(14)
        .font('Helvetica-Bold')
        .fillColor('#1a1a1a')
        .text('SERVICE CONTRACT', { align: 'center' })
        .moveDown(0.3);

      doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor('#888888')
        .text(
          `Date: ${new Date().toLocaleDateString('en-PH', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: 'Asia/Manila',
          })}`,
          { align: 'center' },
        )
        .moveDown(1);

      drawLine(doc);
      doc.moveDown(0.5);

      // ── Section 1: Project Details ──
      sectionHeader(doc, '1. PROJECT DETAILS');

      field(doc, 'Project Title', data.projectTitle, left);
      field(doc, 'Service Type', data.serviceType.replace(/_/g, ' ').toUpperCase(), left);
      field(doc, 'Description', data.projectDescription, left);
      field(doc, 'Site Address', data.siteAddress, left);
      if (data.materialType) field(doc, 'Material', data.materialType, left);
      if (data.finishColor) field(doc, 'Finish/Color', data.finishColor, left);
      field(doc, 'Quantity', String(data.quantity), left);
      if (data.estimatedDuration) field(doc, 'Estimated Duration', data.estimatedDuration, left);
      doc.moveDown(0.5);

      drawLine(doc);
      doc.moveDown(0.5);

      // ── Section 2: Customer Information ──
      sectionHeader(doc, '2. CUSTOMER INFORMATION');

      field(doc, 'Name', data.customerName, left);
      field(doc, 'Email', data.customerEmail, left);
      if (data.customerPhone) field(doc, 'Phone', data.customerPhone, left);
      if (data.customerAddress) field(doc, 'Address', data.customerAddress, left);
      doc.moveDown(0.5);

      drawLine(doc);
      doc.moveDown(0.5);

      // ── Section 3: Payment Terms ──
      sectionHeader(doc, '3. PAYMENT TERMS');

      field(doc, 'Total Contract Amount', formatCurrency(data.totalAmount), left);
      field(doc, 'Payment Type', data.paymentType === 'full' ? 'Full Payment' : 'Installment', left);
      doc.moveDown(0.3);

      // Payment stages table
      doc.fontSize(10).font('Helvetica-Bold').text('Payment Schedule:', left);
      doc.moveDown(0.3);

      for (const stage of data.stages) {
        doc
          .fontSize(9)
          .font('Helvetica')
          .fillColor('#333333')
          .text(
            `  • ${stage.label} — ${stage.percentage}% — ${formatCurrency(stage.amount)}`,
            left + 10,
          );
        doc.moveDown(0.15);
      }
      doc.moveDown(0.5);

      drawLine(doc);
      doc.moveDown(0.5);

      // ── Section 4: Terms & Conditions ──
      sectionHeader(doc, '4. TERMS & CONDITIONS');

      const terms = [
        'The Contractor shall perform the work in a professional manner using quality stainless steel materials.',
        'The Customer agrees to make payments according to the payment schedule above.',
        'Any design changes after blueprint approval may incur additional charges.',
        'The Contractor shall not be liable for delays caused by force majeure events.',
        'A surcharge applies to installment payments as agreed during blueprint acceptance.',
        'The project timeline begins upon receipt of the first payment.',
        'Warranty: 1 year against manufacturing defects under normal use conditions.',
        'This contract is binding upon both parties upon signature.',
      ];

      for (let i = 0; i < terms.length; i++) {
        doc.fontSize(9).font('Helvetica').fillColor('#333333').text(`${i + 1}. ${terms[i]}`, left, undefined, {
          width: pageWidth - 100,
        });
        doc.moveDown(0.2);
      }
      doc.moveDown(1);

      drawLine(doc);
      doc.moveDown(0.5);

      // ── Section 5: Signatures ──
      sectionHeader(doc, '5. SIGNATURES');

      const sigY = doc.y + 10;
      const colWidth = (pageWidth - 100) / 2;

      // Customer signature
      doc.fontSize(9).font('Helvetica').fillColor('#555555').text('Customer:', left, sigY);
      if (signatureBuffer) {
        // Embed the actual e-signature PNG
        try {
          doc.image(signatureBuffer, left, sigY + 14, { width: colWidth - 40, height: 30, fit: [colWidth - 40, 30] });
        } catch {
          // Fallback to blank line if image is corrupt
        }
      }
      doc.y = sigY + 50;
      drawLine(doc, left, left + colWidth - 20);
      doc.fontSize(9).text(data.customerName, left, doc.y + 5);

      // Company signature
      doc.fontSize(9).text('RMV Stainless Steel Fabrication:', left + colWidth + 20, sigY);
      doc.y = sigY + 40;
      drawLine(doc, left + colWidth + 20, pageWidth - 50);
      doc.fontSize(9).text('Authorized Representative', left + colWidth + 20, doc.y + 5);

      // ── Footer ──
      doc.moveDown(2);
      doc
        .fontSize(7)
        .font('Helvetica')
        .fillColor('#999999')
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
