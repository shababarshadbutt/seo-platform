import mongoose, { Document, Model, Schema } from "mongoose";

export interface IWeeklyReport extends Document {
  userId:      string;
  userName:    string;
  websiteId:   string;
  websiteName: string;
  weekStart:   string; // "YYYY-MM-DD" — always Monday
  clicks:      number;
  impressions: number;
  indexation:  number;
  rfqs:        number;
  createdAt:   Date;
  updatedAt:   Date;
}

const WeeklyReportSchema = new Schema<IWeeklyReport>(
  {
    userId:      { type: String, required: true, index: true },
    userName:    { type: String, required: true },
    websiteId:   { type: String, required: true },
    websiteName: { type: String, required: true },
    weekStart:   { type: String, required: true }, // "YYYY-MM-DD"
    clicks:      { type: Number, default: 0 },
    impressions: { type: Number, default: 0 },
    indexation:  { type: Number, default: 0 },
    rfqs:        { type: Number, default: 0 },
  },
  { timestamps: true }
);

// One entry per user+website+week
WeeklyReportSchema.index({ userId: 1, websiteId: 1, weekStart: 1 }, { unique: true });
WeeklyReportSchema.index({ weekStart: 1 });

const WeeklyReport: Model<IWeeklyReport> =
  mongoose.models.WeeklyReport ??
  mongoose.model<IWeeklyReport>("WeeklyReport", WeeklyReportSchema);

export default WeeklyReport;
