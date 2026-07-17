import mongoose, { Document, Model, Schema, Types } from "mongoose";

export type ExecutionStatus = "running" | "success" | "error";

export interface IExecutionLog extends Document {
  userId: Types.ObjectId | null;
  userEmail: string;
  userName: string;
  scriptSlug: string;
  scriptName: string;
  inputs: Record<string, unknown>;
  output: string;
  status: ExecutionStatus;
  exitCode: number | null;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  isAutomated: boolean;
  websiteId: string | null;
  websiteName: string | null;
}

const ExecutionLogSchema = new Schema<IExecutionLog>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: false,
      default: null,
    },
    userEmail: { type: String, required: true },
    userName: { type: String, required: true },
    scriptSlug: { type: String, required: true },
    scriptName: { type: String, required: true },
    // The form inputs passed to the script (varies per script)
    inputs: { type: Schema.Types.Mixed, default: {} },
    // Full stdout + stderr captured during execution
    output: { type: String, default: "" },
    status: {
      type: String,
      enum: ["running", "success", "error"],
      default: "running",
    },
    exitCode: { type: Number, default: null },
    startedAt: { type: Date, default: () => new Date() },
    completedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },
    isAutomated: { type: Boolean, default: false },
    websiteId:   { type: String, default: null },
    websiteName: { type: String, default: null },
  },
  {
    // No auto timestamps — we manage startedAt/completedAt manually
    timestamps: false,
  }
);

// Indexes for the logs page filters
ExecutionLogSchema.index({ userId: 1 });
ExecutionLogSchema.index({ scriptSlug: 1 });
ExecutionLogSchema.index({ status: 1 });
ExecutionLogSchema.index({ startedAt: -1 });

const ExecutionLog: Model<IExecutionLog> =
  mongoose.models.ExecutionLog ??
  mongoose.model<IExecutionLog>("ExecutionLog", ExecutionLogSchema);

export default ExecutionLog;
