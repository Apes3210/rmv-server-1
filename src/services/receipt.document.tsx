import React from 'react';
import {
  Document,
  Page,
  View,
  Text,
  Image,
  StyleSheet,
} from '@react-pdf/renderer';
import type { ReceiptData } from './receipt.service.js';

/* ── Currency formatter (ASCII-safe) ── */
function fmtCurrency(amount: number): string {
  return (
    'Php ' +
    amount.toLocaleString('en-PH', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

/* ── Styles ── */
const s = StyleSheet.create({
  page: {
    paddingTop: 50,
    paddingBottom: 50,
    paddingHorizontal: 50,
    fontFamily: 'Helvetica',
    fontSize: 10,
    color: '#000',
    lineHeight: 1.4,
  },
  center: { textAlign: 'center' },

  /* header */
  headerWrap: { alignItems: 'center', marginBottom: 6 },
  companyName: { fontSize: 16, fontFamily: 'Helvetica-Bold', color: '#1a1a1a' },
  companyDetail: { fontSize: 8, color: '#444', marginTop: 1 },
  tinLine: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#333', marginTop: 4 },
  receiptTitle: { fontSize: 15, fontFamily: 'Helvetica-Bold', color: '#1a1a1a', marginTop: 10, marginBottom: 8, textAlign: 'center' },

  /* divider */
  divider: { borderBottomWidth: 0.8, borderBottomColor: '#ccc', marginVertical: 8 },

  /* section label */
  sectionLabel: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: '#1a1a1a', marginBottom: 6 },

  /* key-value rows */
  row: { flexDirection: 'row', marginBottom: 3 },
  rowLabel: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: '#333', width: 130 },
  rowValue: { fontSize: 10, color: '#1a1a1a', flex: 1 },

  /* table */
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: '#333',
    paddingVertical: 4,
    paddingHorizontal: 8,
    marginBottom: 2,
  },
  tableHeaderText: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: '#fff' },
  tableRow: { flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 3 },
  tableCell: { fontSize: 10, color: '#333' },
  tableCellBold: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: '#333' },

  /* total */
  totalRow: {
    flexDirection: 'row',
    borderTopWidth: 1.5,
    borderTopColor: '#333',
    paddingTop: 6,
    paddingHorizontal: 8,
    marginTop: 2,
  },
  totalLabel: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: '#1a1a1a', width: '60%' },
  totalValue: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: '#1a1a1a', width: '40%', textAlign: 'right' },

  /* signature */
  sigWrap: { alignItems: 'flex-end', marginTop: 20 },
  sigBox: { width: 200, alignItems: 'center' },
  sigLabel: { fontSize: 10, color: '#333', marginBottom: 24 },
  sigLine: { borderBottomWidth: 0.5, borderBottomColor: '#333', width: '100%', marginBottom: 4 },
  sigName: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: '#1a1a1a' },
  sigSub: { fontSize: 8, color: '#666', marginTop: 2 },

  /* footer */
  footer: { marginTop: 20, borderTopWidth: 0.8, borderTopColor: '#ccc', paddingTop: 8, alignItems: 'center' },
  footerText: { fontSize: 7, color: '#666', marginBottom: 2 },
});

/* ── Receipt info row (date/receipt#) ── */
const InfoRow = ({
  leftLabel,
  leftValue,
  rightLabel,
  rightValue,
}: {
  leftLabel: string;
  leftValue: string;
  rightLabel: string;
  rightValue: string;
}) => (
  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
    <View style={{ flexDirection: 'row' }}>
      <Text style={{ fontSize: 10, fontFamily: 'Helvetica-Bold' }}>{leftLabel}: </Text>
      <Text style={{ fontSize: 10 }}>{leftValue}</Text>
    </View>
    <View style={{ flexDirection: 'row' }}>
      <Text style={{ fontSize: 10, fontFamily: 'Helvetica-Bold' }}>{rightLabel}: </Text>
      <Text style={{ fontSize: 10 }}>{rightValue}</Text>
    </View>
  </View>
);

const Field = ({ label, value }: { label: string; value: string }) => (
  <View style={s.row}>
    <Text style={s.rowLabel}>{label}:</Text>
    <Text style={s.rowValue}>{value}</Text>
  </View>
);

/* ── Main Document ── */

export interface ReceiptDocumentProps {
  data: ReceiptData;
}

export const ReceiptDocument: React.FC<ReceiptDocumentProps> = ({ data }) => {
  const grossAmount = data.amountPaid;
  const vatableSales = grossAmount / 1.12;
  const vatAmount = grossAmount - vatableSales;

  const amountRows: [string, string, boolean][] = [
    ['Gross Amount', fmtCurrency(grossAmount), true],
    ['VATable Sales', fmtCurrency(vatableSales), false],
    ['12% VAT', fmtCurrency(vatAmount), false],
  ];
  if (data.creditApplied > 0) {
    amountRows.push(['Credit Applied', fmtCurrency(data.creditApplied), false]);
  }
  if (data.excessCredit > 0) {
    amountRows.push(['Excess Credit (Carry Forward)', fmtCurrency(data.excessCredit), false]);
  }

  const dateFmt = data.verifiedAt.toLocaleDateString('en-PH', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Asia/Manila',
  });
  const generatedAt = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' });

  return (
    <Document
      title={`Receipt ${data.receiptNumber}`}
      author="RMV Stainless Steel Fabrication"
    >
      <Page size="A4" style={s.page}>
        {/* ── Company Header ── */}
        <View style={s.headerWrap}>
          <Text style={s.companyName}>RMV STAINLESS STEEL FABRICATION</Text>
          <Text style={s.companyDetail}>BIR Village, Novaliches, Quezon City, Metro Manila 1118</Text>
          <Text style={s.companyDetail}>Tel: 02-9506187 | Mobile: 0945 285 2974</Text>
          <Text style={s.companyDetail}>Email: rmvstainless@gmail.com</Text>
          <Text style={s.tinLine}>TIN: 123-456-789-000  |  VAT Registered</Text>
        </View>

        <Text style={s.receiptTitle}>OFFICIAL RECEIPT</Text>
        <View style={s.divider} />

        {/* ── Receipt No / Date ── */}
        <InfoRow
          leftLabel="Receipt No"
          leftValue={data.receiptNumber}
          rightLabel="Date"
          rightValue={dateFmt}
        />
        <View style={s.divider} />

        {/* ── Bill To ── */}
        <Text style={s.sectionLabel}>BILL TO</Text>
        <Field label="Customer" value={data.customerName} />
        {data.customerAddress ? <Field label="Address" value={data.customerAddress} /> : null}
        <Field label="Email" value={data.customerEmail} />
        {data.customerTin ? <Field label="TIN" value={data.customerTin} /> : null}
        <View style={s.divider} />

        {/* ── Project Details ── */}
        <Text style={s.sectionLabel}>PROJECT DETAILS</Text>
        <Field label="Project" value={data.projectTitle} />
        <Field label="Payment Stage" value={data.stageName} />
        {data.referenceNumber ? <Field label="Reference No" value={data.referenceNumber} /> : null}
        <View style={s.divider} />

        {/* ── Payment Breakdown ── */}
        <Text style={s.sectionLabel}>PAYMENT BREAKDOWN</Text>

        {/* table header */}
        <View style={s.tableHeader}>
          <Text style={[s.tableHeaderText, { width: '60%' }]}>Description</Text>
          <Text style={[s.tableHeaderText, { width: '40%', textAlign: 'right' }]}>Amount</Text>
        </View>

        {/* table rows */}
        {amountRows.map(([label, value, bold], i) => (
          <View key={i} style={s.tableRow}>
            <Text style={[bold ? s.tableCellBold : s.tableCell, { width: '60%' }]}>{label}</Text>
            <Text style={[bold ? s.tableCellBold : s.tableCell, { width: '40%', textAlign: 'right' }]}>{value}</Text>
          </View>
        ))}

        {/* total */}
        <View style={s.totalRow}>
          <Text style={s.totalLabel}>TOTAL AMOUNT PAID</Text>
          <Text style={s.totalValue}>{fmtCurrency(grossAmount)}</Text>
        </View>

        {/* Payment Method */}
        <View style={{ marginTop: 10 }}>
          <Field label="Payment Method" value={data.paymentMethod.replace(/_/g, ' ').toUpperCase()} />
        </View>
        <View style={s.divider} />

        {/* ── Project Summary ── */}
        <Text style={s.sectionLabel}>PROJECT SUMMARY</Text>
        <Field label="Total Project Cost" value={fmtCurrency(data.totalProjectCost)} />
        <Field label="Total Paid to Date" value={fmtCurrency(data.totalPaid)} />
        <Field label="Outstanding Balance" value={fmtCurrency(data.totalOutstanding)} />

        {/* ── Signature ── */}
        <View style={s.sigWrap}>
          <View style={s.sigBox}>
            <Text style={s.sigLabel}>Authorized Signature:</Text>
            {data.cashierSignatureUrl ? (
              <Image source={{ uri: data.cashierSignatureUrl }} style={{ width: 120, height: 48, objectFit: 'contain', marginBottom: 4 }} />
            ) : null}
            <View style={s.sigLine} />
            <Text style={s.sigName}>{data.verifiedByName}</Text>
            <Text style={s.sigSub}>Printed Name / Verified By</Text>
          </View>
        </View>

        {/* ── Footer ── */}
        <View style={s.footer}>
          <Text style={s.footerText}>
            This is a system-generated official receipt issued by RMV Stainless Steel Fabrication.
          </Text>
          <Text style={s.footerText}>Generated on {generatedAt}</Text>
          <Text style={s.footerText}>
            ATP No.: 0XXXXXXXXX-XXXX-XXXX-XXXX  |  Date Issued: ___________  |  Valid Until: ___________
          </Text>
          <Text style={s.footerText}>
            RMV Stainless Steel Fabrication -- BIR Village, Novaliches, Quezon City 1118
          </Text>
        </View>
      </Page>
    </Document>
  );
};

export default ReceiptDocument;
