import mongoose, { Document, Model, Schema } from "mongoose";

export interface IDailyReport extends Document {
  userId: string;
  userName: string;
  date: Date;
  report: string;
  type: "report" | "leave" | "public-holiday";
  createdAt: Date;
  updatedAt: Date;
}

const DailyReportSchema = new Schema<IDailyReport>(
  {
    userId:   { type: String, required: true, index: true },
    userName: { type: String, required: true },
    date:     { type: Date,   required: true },
    report:   { type: String, required: true, trim: true },
    type:     { type: String, default: "report" },
  },
  { timestamps: true }
);

DailyReportSchema.index({ userId: 1, date: -1 });
DailyReportSchema.index({ date: -1 });

const DailyReport: Model<IDailyReport> =
  mongoose.models.DailyReport ??
  mongoose.model<IDailyReport>("DailyReport", DailyReportSchema);

export default DailyReport;
