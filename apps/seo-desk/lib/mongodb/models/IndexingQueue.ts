import mongoose, { Document, Model, Schema } from "mongoose";

export type IndexingStatus = "pending" | "submitted" | "failed";

export interface IIndexingQueue extends Document {
  websiteId:       string;
  url:             string;
  discoveredAt:    Date;
  gscStatus:       IndexingStatus;
  gscSubmittedAt:  Date | null;
  gscError:        string | null;
  bingStatus:      IndexingStatus;
  bingSubmittedAt: Date | null;
  bingError:       string | null;
}

const IndexingQueueSchema = new Schema<IIndexingQueue>(
  {
    websiteId:       { type: String, required: true },
    url:             { type: String, required: true },
    discoveredAt:    { type: Date, default: () => new Date() },
    gscStatus:       { type: String, enum: ["pending", "submitted", "failed"], default: "pending" },
    gscSubmittedAt:  { type: Date, default: null },
    gscError:        { type: String, default: null },
    bingStatus:      { type: String, enum: ["pending", "submitted", "failed"], default: "pending" },
    bingSubmittedAt: { type: Date, default: null },
    bingError:       { type: String, default: null },
  },
  { timestamps: false }
);

IndexingQueueSchema.index({ websiteId: 1, url: 1 }, { unique: true });
IndexingQueueSchema.index({ websiteId: 1, gscStatus: 1 });
IndexingQueueSchema.index({ websiteId: 1, bingStatus: 1 });

const IndexingQueue: Model<IIndexingQueue> =
  mongoose.models.IndexingQueue ??
  mongoose.model<IIndexingQueue>("IndexingQueue", IndexingQueueSchema);

export default IndexingQueue;
