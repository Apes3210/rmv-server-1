import PDFDocument from 'pdfkit';
import { formatCurrency, generateReceiptNumber } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

export interface ReceiptData {
  receiptNumber: string;
  customerName: string;
  customerEmail: string;
  customerAddress?: string;
  customerTin?: string;
  projectTitle: string;
  stageName: string;
  amountPaid: number;
  paymentMethod: string;
  referenceNumber?: string;
  creditApplied: number;
  excessCredit: number;
  verifiedByName: string;
  verifiedAt: Date;
  totalProjectCost: number;
  totalPaid: number;
  totalOutstanding: number;
}

/**
 * Generate a BIR-compliant receipt PDF and return as Buffer
 */
export async function generateReceiptPdf(data: ReceiptData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: {
          Title: `Receipt ${data.receiptNumber}`,
          Author: 'RMV Stainless Steel Fabrication',
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const leftMargin = 50;
      const rightEdge = doc.page.width - 50;
      const contentWidth = rightEdge - leftMargin;

      // ── Company Header ──
      doc
        .fontSize(18)
        .font('Helvetica-Bold')
        .text('RMV STAINLESS STEEL FABRICATION', { align: 'center' });

      doc
        .fontSize(9)
        .font('Helvetica')
        .text('BIR Village, Novaliches, Quezon City, Metro Manila 1118', { align: 'center' })
        .text('Tel: 02-9506187 | Mobile: 0945 285 2974', { align: 'center' })
        .text('Email: rmvstainless@gmail.com', { align: 'center' })
        .moveDown(0.3);

      doc
        .fontSize(9)
        .font('Helvetica-Bold')
        .text('TIN: 123-456-789-000  |  VAT Registered', { align: 'center' })
        .moveDown(0.8);

      // ── OFFICIAL RECEIPT title ──
      doc
        .fontSize(16)
        .font('Helvetica-Bold')
        .text('OFFICIAL RECEIPT', { align: 'center' })
        .moveDown(0.8);

      drawLine(doc);
      doc.moveDown(0.5);

      // ── Receipt No & Date Row ──
      let y = doc.y;
      doc.fontSize(10).font('Helvetica-Bold').text('Receipt No:', leftMargin, y);
      doc.font('Helvetica').text(data.receiptNumber, leftMargin + 80, y);

      doc.font('Helvetica-Bold').text('Date:', rightEdge - 200, y);
      doc.font('Helvetica').text(
        data.verifiedAt.toLocaleDateString('en-PH', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          timeZone: 'Asia/Manila',
        }),
        rightEdge - 160,
        y,
      );

      doc.moveDown(1);

      // ── Bill To ──
      drawLine(doc);
      doc.moveDown(0.5);

      doc.fontSize(12).font('Helvetica-Bold').text('BILL TO', leftMargin);
      doc.moveDown(0.4);

      y = doc.y;
      doc.fontSize(10).font('Helvetica-Bold').text('Customer:', leftMargin, y);
      doc.font('Helvetica').text(data.customerName, leftMargin + 80, y);
      y += 16;

      if (data.customerAddress) {
        doc.font('Helvetica-Bold').text('Address:', leftMargin, y);
        doc.font('Helvetica').text(data.customerAddress, leftMargin + 80, y, { width: contentWidth - 80 });
        y = doc.y + 4;
      }

      doc.font('Helvetica-Bold').text('Email:', leftMargin, y);
      doc.font('Helvetica').text(data.customerEmail, leftMargin + 80, y);
      y += 16;

      if (data.customerTin) {
        doc.font('Helvetica-Bold').text('TIN:', leftMargin, y);
        doc.font('Helvetica').text(data.customerTin, leftMargin + 80, y);
        y += 16;
      }

      doc.y = y + 8;

      // ── Project & Payment Stage ──
      drawLine(doc);
      doc.moveDown(0.5);

      doc.fontSize(12).font('Helvetica-Bold').text('PROJECT DETAILS', leftMargin);
      doc.moveDown(0.4);

      y = doc.y;
      doc.fontSize(10).font('Helvetica-Bold').text('Project:', leftMargin, y);
      doc.font('Helvetica').text(data.projectTitle, leftMargin + 80, y, { width: contentWidth - 80 });
      y = doc.y + 4;

      doc.font('Helvetica-Bold').text('Payment Stage:', leftMargin, y);
      doc.font('Helvetica').text(data.stageName, leftMargin + 100, y);
      y += 16;

      if (data.referenceNumber) {
        doc.font('Helvetica-Bold').text('Reference No:', leftMargin, y);
        doc.font('Helvetica').text(data.referenceNumber, leftMargin + 100, y);
        y += 16;
      }

      doc.y = y + 8;

      // ── Payment Amount & VAT Breakdown ──
      drawLine(doc);
      doc.moveDown(0.5);

      doc.fontSize(12).font('Helvetica-Bold').text('PAYMENT BREAKDOWN', leftMargin);
      doc.moveDown(0.5);

      const grossAmount = data.amountPaid;
      const vatableSales = grossAmount / 1.12;
      const vatAmount = grossAmount - vatableSales;

      const amountRows: [string, string][] = [
        ['Gross Amount', formatCurrency(grossAmount)],
        ['VATable Sales', formatCurrency(vatableSales)],
        ['12% VAT', formatCurrency(vatAmount)],
      ];

      if (data.creditApplied > 0) {
        amountRows.push(['Credit Applied', formatCurrency(data.creditApplied)]);
      }
      if (data.excessCredit > 0) {
        amountRows.push(['Excess Credit (Carry Forward)', formatCurrency(data.excessCredit)]);
      }

      // Table header row
      y = doc.y;
      doc.fontSize(9).font('Helvetica-Bold')
        .fillColor('#ffffff');

      doc.rect(leftMargin, y - 2, contentWidth, 18).fill('#333333');
      doc.text('Description', leftMargin + 8, y + 2, { width: contentWidth * 0.6 });
      doc.text('Amount', leftMargin + contentWidth * 0.6, y + 2, { width: contentWidth * 0.35, align: 'right' });
      
      doc.fillColor('#000000');
      y += 20;

      for (const [label, value] of amountRows) {
        const isTotal = label === 'Gross Amount';
        doc.fontSize(10).font(isTotal ? 'Helvetica-Bold' : 'Helvetica');
        doc.text(label, leftMargin + 8, y, { width: contentWidth * 0.6 });
        doc.text(value, leftMargin + contentWidth * 0.6, y, { width: contentWidth * 0.35, align: 'right' });
        y += 18;
      }

      // Total line
      doc.moveTo(leftMargin, y).lineTo(rightEdge, y).lineWidth(1.5).strokeColor('#333333').stroke();
      y += 6;

      doc.fontSize(11).font('Helvetica-Bold');
      doc.text('TOTAL AMOUNT PAID', leftMargin + 8, y, { width: contentWidth * 0.6 });
      doc.text(formatCurrency(grossAmount), leftMargin + contentWidth * 0.6, y, { width: contentWidth * 0.35, align: 'right' });
      y += 22;

      doc.y = y;

      // ── Payment Method ──
      doc.fontSize(10).font('Helvetica-Bold').text('Payment Method:', leftMargin, doc.y);
      doc.font('Helvetica').text(
        data.paymentMethod.replace(/_/g, ' ').toUpperCase(),
        leftMargin + 110,
        doc.y - doc.currentLineHeight(),
      );
      doc.moveDown(1);

      // ── Project Summary ──
      drawLine(doc);
      doc.moveDown(0.5);

      doc.fontSize(10).font('Helvetica-Bold').text('PROJECT SUMMARY', leftMargin);
      doc.moveDown(0.4);

      const summaryData: [string, string][] = [
        ['Total Project Cost', formatCurrency(data.totalProjectCost)],
        ['Total Paid to Date', formatCurrency(data.totalPaid)],
        ['Outstanding Balance', formatCurrency(data.totalOutstanding)],
      ];

      for (const [label, value] of summaryData) {
        y = doc.y;
        doc.fontSize(10).font('Helvetica-Bold').text(label + ':', leftMargin, y, { width: 200 });
        doc.font('Helvetica').text(value, leftMargin + 200, y);
        doc.moveDown(0.3);
      }

      doc.moveDown(1.5);

      // ── Authorized Signature ──
      drawLine(doc);
      doc.moveDown(1);

      const sigX = rightEdge - 200;
      doc.fontSize(10).font('Helvetica').text('Authorized Signature:', sigX, doc.y, { width: 200, align: 'center' });
      doc.moveDown(2);

      // Signature line
      doc.moveTo(sigX + 20, doc.y).lineTo(sigX + 180, doc.y).lineWidth(0.5).strokeColor('#333333').stroke();
      doc.moveDown(0.3);

      doc.fontSize(9).font('Helvetica-Bold').text(data.verifiedByName, sigX, doc.y, { width: 200, align: 'center' });
      doc.moveDown(0.2);
      doc.fontSize(8).font('Helvetica').fillColor('#666666').text('Printed Name / Verified By', sigX, doc.y, { width: 200, align: 'center' });

      doc.moveDown(2);

      // ── Footer ──
      drawLine(doc);
      doc.moveDown(0.5);

      doc.fillColor('#666666');

      doc
        .fontSize(7)
        .font('Helvetica')
        .text(
          'This is a system-generated official receipt issued by RMV Stainless Steel Fabrication.',
          { align: 'center' },
        )
        .moveDown(0.2)
        .text(
          `Generated on ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}`,
          { align: 'center' },
        )
        .moveDown(0.3)
        .text(
          'ATP No.: 0XXXXXXXXX-XXXX-XXXX-XXXX  |  Date Issued: ___________  |  Valid Until: ___________',
          { align: 'center' },
        )
        .moveDown(0.2)
        .text(
          'RMV Stainless Steel Fabrication — BIR Village, Novaliches, Quezon City 1118',
          { align: 'center' },
        );

      doc.end();
    } catch (error) {
      logger.error('Failed to generate receipt PDF', error);
      reject(error);
    }
  });
}

function drawLine(doc: PDFKit.PDFDocument) {
  const y = doc.y;
  doc
    .strokeColor('#cccccc')
    .lineWidth(1)
    .moveTo(50, y)
    .lineTo(doc.page.width - 50, y)
    .stroke();
}
