import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { logger } from '../utils/logger.js';
import { ReceiptDocument } from './receipt.document.js';

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
 * Generate a BIR-compliant receipt PDF using @react-pdf/renderer
 */
export async function generateReceiptPdf(data: ReceiptData): Promise<Buffer> {
  try {
    const element = React.createElement(ReceiptDocument, { data });
    const pdfBuffer = await renderToBuffer(element as any);
    return Buffer.from(pdfBuffer);
  } catch (error) {
    logger.error('Failed to generate receipt PDF', error);
    throw error;
  }
}