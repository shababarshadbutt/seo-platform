import mongoose, { Document, Model, Schema } from "mongoose";

export interface IAuditResult {
  pointId: string;
  heading: string;
  checked: boolean;
  details: string;
}

export interface IAuditRecord extends Document {
  websiteName: string;
  websiteUrl: string;
  submittedBy: string;
  submittedByName: string;
  date: Date;
  results: IAuditResult[];
  createdAt: Date;
  updatedAt: Date;
}

const AuditResultSchema = new Schema<IAuditResult>(
  {
    pointId: { type: String, required: true },
    heading: { type: String, required: true },
    checked: { type: Boolean, default: false },
    details: { type: String, default: "" },
  },
  { _id: false }
);

const AuditRecordSchema = new Schema<IAuditRecord>(
  {
    websiteName:     { type: String, required: true, trim: true },
    websiteUrl:      { type: String, required: true, trim: true },
    submittedBy:     { type: String, required: true },
    submittedByName: { type: String, required: true },
    date:            { type: Date, required: true },
    results:         [AuditResultSchema],
  },
  { timestamps: true }
);

AuditRecordSchema.index({ submittedBy: 1 });
AuditRecordSchema.index({ date: -1 });

const AuditRecord: Model<IAuditRecord> =
  mongoose.models.AuditRecord ??
  mongoose.model<IAuditRecord>("AuditRecord", AuditRecordSchema);

export default AuditRecord;
