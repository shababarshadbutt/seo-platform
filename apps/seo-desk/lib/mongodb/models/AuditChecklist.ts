import mongoose, { Document, Model, Schema } from "mongoose";

export interface IAuditChecklist extends Document {
  heading: string;
  description: string;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const AuditChecklistSchema = new Schema<IAuditChecklist>(
  {
    heading:     { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    order:       { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

const AuditChecklist: Model<IAuditChecklist> =
  mongoose.models.AuditChecklist ??
  mongoose.model<IAuditChecklist>("AuditChecklist", AuditChecklistSchema);

export default AuditChecklist;
