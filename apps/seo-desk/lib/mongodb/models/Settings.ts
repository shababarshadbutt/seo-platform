import mongoose, { Document, Model, Schema } from "mongoose";

export interface IGscProperty {
  url: string;
  displayName: string;
}

export interface IGa4Property {
  propertyId: string;
  displayName: string;
}

export interface IServiceAccount {
  name: string;       // User-given label e.g. "ASAP Main Account"
  json: string;       // Raw service account JSON string
}

export interface ISettings extends Document {
  singleton: true;
  serviceAccounts: IServiceAccount[];
  gscProperties: IGscProperty[];
  ga4Properties: IGa4Property[];
  updatedAt: Date;
}

const ServiceAccountSchema = new Schema<IServiceAccount>(
  {
    name: { type: String, required: true },
    json: { type: String, required: true },
  },
  { _id: false }
);

const GscPropertySchema = new Schema<IGscProperty>(
  {
    url: { type: String, required: true },
    displayName: { type: String, required: true },
  },
  { _id: false }
);

const Ga4PropertySchema = new Schema<IGa4Property>(
  {
    propertyId: { type: String, required: true },
    displayName: { type: String, required: true },
  },
  { _id: false }
);

const SettingsSchema = new Schema<ISettings>(
  {
    singleton: { type: Boolean, default: true, immutable: true },
    serviceAccounts: { type: [ServiceAccountSchema], default: [] },
    gscProperties: { type: [GscPropertySchema], default: [] },
    ga4Properties: { type: [Ga4PropertySchema], default: [] },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);

SettingsSchema.index({ singleton: 1 }, { unique: true });

const Settings: Model<ISettings> =
  mongoose.models.Settings ??
  mongoose.model<ISettings>("Settings", SettingsSchema);

export default Settings;
