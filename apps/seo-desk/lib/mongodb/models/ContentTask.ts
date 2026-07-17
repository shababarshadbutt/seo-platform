import mongoose, { Document, Model, Schema } from "mongoose";

export type ContentTaskType =
  | "landing-request"
  | "blog-request"
  | "landing-update"
  | "blog-publish";

export type ContentTaskStatus = "pending" | "in-progress" | "done";

export interface IContentTask extends Document {
  userId: string;
  userName: string;
  taskType: ContentTaskType;
  websiteName: string;
  websiteUrl: string;
  status: ContentTaskStatus;
  date: Date;
  // landing-request
  docsLink?: string;
  pageUrls?: string[];
  // blog-request
  sheetLink?: string;
  blogTopics?: string[];
  // landing-update
  updatedPageLinks?: string[];
  // blog-publish
  publishedBlogLinks?: string[];
  createdAt: Date;
  updatedAt: Date;
}

const ContentTaskSchema = new Schema<IContentTask>(
  {
    userId: { type: String, required: true, index: true },
    userName: { type: String, required: true },
    taskType: {
      type: String,
      enum: ["landing-request", "blog-request", "landing-update", "blog-publish"],
      required: true,
      index: true,
    },
    websiteName: { type: String, required: true, trim: true },
    websiteUrl: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["pending", "in-progress", "done"],
      default: "pending",
    },
    date: { type: Date, required: true },
    docsLink: { type: String },
    pageUrls: [{ type: String }],
    sheetLink: { type: String },
    blogTopics: [{ type: String }],
    updatedPageLinks: [{ type: String }],
    publishedBlogLinks: [{ type: String }],
  },
  { timestamps: true }
);

const ContentTask: Model<IContentTask> =
  mongoose.models.ContentTask ??
  mongoose.model<IContentTask>("ContentTask", ContentTaskSchema);

export default ContentTask;
