import mongoose, { Document, Model, Schema } from "mongoose";

export interface IBacklinkSite extends Document {
  url:         string;
  da:          number | null;
  spamScore:   number | null;
  niche:       string;
  notes:       string;
  reusable:    boolean;
  addedBy:     string;
  addedByName: string;
  createdAt:   Date;
  updatedAt:   Date;
}

const BacklinkSiteSchema = new Schema<IBacklinkSite>(
  {
    url:         { type: String, required: true, trim: true },
    da:          { type: Number, default: null },
    spamScore:   { type: Number, default: null },
    niche:       { type: String, default: "", trim: true },
    notes:       { type: String, default: "", trim: true },
    reusable:    { type: Boolean, default: false },
    addedBy:     { type: String, required: true },
    addedByName: { type: String, required: true },
  },
  { timestamps: true }
);

BacklinkSiteSchema.index({ addedBy: 1 });

const BacklinkSite: Model<IBacklinkSite> =
  mongoose.models.BacklinkSite ??
  mongoose.model<IBacklinkSite>("BacklinkSite", BacklinkSiteSchema);

export default BacklinkSite;
