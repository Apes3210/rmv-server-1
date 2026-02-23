import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

await mongoose.connect(process.env.MONGODB_URI);
const col = mongoose.connection.db.collection('appointments');

const appt = await col.findOne({ _id: new mongoose.Types.ObjectId('699c6b0d431aa121c6f53981') });
if (!appt) { console.log('Not found'); process.exit(1); }

await col.updateOne({ _id: appt._id }, {
  $set: {
    ocularFeePaid: false,
    ocularFeeStatus: 'pending',
    ocularFee: 4242,
    'ocularFeeBreakdown.total': 4242
  },
  $unset: {
    paymongoCheckoutSessionId: '',
    paymongoCheckoutUrl: '',
    ocularFeeDeclineReason: ''
  }
});

console.log('Done - fee reset to pending (P4,242), old checkout session cleared');
await mongoose.disconnect();
