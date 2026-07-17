import mongoose, { Document, Model, Schema } from "mongoose";

export interface IGroup extends Document {
  name: string;
  leadUserId: mongoose.Types.ObjectId;
  memberUserIds: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const GroupSchema = new Schema<IGroup>(
  {
    name: {
      type: String,
      required: [true, "Group name is required"],
      trim: true,
    },
    leadUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Group lead is required"],
    },
    memberUserIds: [{ type: Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

const Group: Model<IGroup> =
  mongoose.models.Group ?? mongoose.model<IGroup>("Group", GroupSchema);

export default Group;
