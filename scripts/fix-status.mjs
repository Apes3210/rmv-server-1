import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();
await mongoose.connect(process.env.MONGODB_URI);
const r = await mongoose.connection.db.collection('appointments').updateOne(
  { _id: new mongoose.Types.ObjectId('69a5791618baf896d141d384') },
  { $set: { status: 'confirmed' } }
);
console.log('Modified:', r.modifiedCount);
await mongoose.disconnect();
