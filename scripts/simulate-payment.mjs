import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
await mongoose.connect(MONGODB_URI);

const db = mongoose.connection.db;
const col = db.collection('appointments');

const appt = await col.findOne(
  { ocularFeeStatus: 'pending', type: 'ocular' },
  { sort: { createdAt: -1 } }
);

if (!appt) {
  console.log('No pending ocular appointment found');
  await mongoose.disconnect();
  process.exit(0);
}

console.log('Appointment ID:', appt._id.toString());
console.log('Date:', appt.date);
console.log('Fee:', appt.ocularFee);
console.log('Current fee status:', appt.ocularFeeStatus);

await col.updateOne(
  { _id: appt._id },
  { $set: { ocularFeePaid: true, ocularFeeStatus: 'verified' }, $unset: { ocularFeeDeclineReason: '' } }
);

console.log('✅ Payment simulated — ocularFeeStatus set to "verified"');
await mongoose.disconnect();
