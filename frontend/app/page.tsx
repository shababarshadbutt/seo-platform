"use client";

import {
  ChangeEvent,
  DragEvent,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  FolderOpen,
  Info,
  LinkIcon,
  Loader2,
  Search,
  UploadCloud,
  X
} from "lucide-react";

import {
  apiErrorPayload,
  completeSitemapUpload,
  createSession,
  friendlyApiErrorMessage,
  getSystemDiskUsage,
  previewSitemapUrl,
  submitSitemapUrls,
  type SitemapUrlPreview,
  type UploadProgress,
  type UploadRejectedFile,
  uploadSitemap
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { UploadRejections } from "@/components/upload-rejections";

const sampleSizeOptions = [5, 10, 20];
const MAX_SITEMAP_URL_FIELDS = 20;
// Upload in small chunks sent a few at a time, so a large session's files go up
// in parallel streams instead of one giant request (v1.33 Fix 2).
const UPLOAD_BATCH_SIZE = 50;
const MAX_CONCURRENT_UPLOADS = 3;
const LARGE_UPLOAD_WARNING_THRESHOLD = 500;
const SITEMAP_URL_FETCH_ERROR =
  "Could not fetch sitemap — check the URL and try again";

type SourceMode = "file" | "url";
type SitemapUrlField = {
  id: string;
  value: string;
  touched: boolean;
  preview: SitemapUrlPreview | null;
  previewSource: string;
  error: string;
};

function isHttpBaseUrl(value: string) {
  return value.startsWith("http://") || value.startsWith("https://");
}

function isXmlFile(file: File) {
  return file.name.toLowerCase().endsWith(".xml");
}

function formatFileSize(bytes: number) {
  const kilobytes = bytes / 1024;

  if (kilobytes >= 1024) {
    return `${(kilobytes / 1024).toFixed(1)} MB`;
  }

  return `${Math.max(1, Math.round(kilobytes))} KB`;
}

function formatStorageSize(megabytes: number) {
  if (megabytes >= 1024) {
    return `${(megabytes / 1024).toFixed(1)} GB`;
  }

  return `${megabytes.toFixed(1)} MB`;
}

function formatCount(value: unknown) {
  const parsed = Number(value);

  return new Intl.NumberFormat("en-US").format(
    Number.isFinite(parsed) ? parsed : 0
  );
}

function prepareFolderPickerInput(input: HTMLInputElement | null) {
  if (!input) {
    return;
  }

  input.setAttribute("webkitdirectory", "");
  input.setAttribute("directory", "");
  input.multiple = true;
}

function normalizedHttpUrl(value: string) {
  try {
    return new URL(value).toString();
  } catch {
    return value.trim();
  }
}

function normalizeDomainHost(hostname: string) {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function hostFromHttpUrl(value: string) {
  try {
    const url = new URL(value);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    return normalizeDomainHost(url.hostname);
  } catch {
    return null;
  }
}

function createSitemapUrlField(id = `url-${Date.now()}-${Math.random()}`): SitemapUrlField {
  return {
    id,
    value: "",
    touched: false,
    preview: null,
    previewSource: "",
    error: ""
  };
}

function clearSitemapUrlPreview(field: SitemapUrlField): SitemapUrlField {
  return {
    ...field,
    preview: null,
    previewSource: "",
    error: ""
  };
}

function selectedFileLabel(file: File) {
  return file.webkitRelativePath || file.name;
}

function selectedFileKey(file: File) {
  return `${selectedFileLabel(file)}:${file.size}:${file.lastModified}`;
}

function confirmLargeUpload(fileCount: number) {
  return (
    fileCount < LARGE_UPLOAD_WARNING_THRESHOLD ||
    window.confirm(
      `You are uploading ${fileCount} files. This will be processed in the background and may take 10–20 minutes. You can close this tab and return later — your session will be saved. Continue?`
    )
  );
}

function chunkFiles(files: File[], batchSize: number) {
  const batches: File[][] = [];

  for (let index = 0; index < files.length; index += batchSize) {
    batches.push(files.slice(index, index + batchSize));
  }

  return batches;
}

function uploadRejectionsFromPayload(payload: unknown): UploadRejectedFile[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const rejectedFiles = (payload as { rejected_files?: unknown }).rejected_files;

  if (!Array.isArray(rejectedFiles)) {
    return [];
  }

  return rejectedFiles.filter(
    (rejectedFile): rejectedFile is UploadRejectedFile =>
      Boolean(
        rejectedFile &&
          typeof rejectedFile === "object" &&
          typeof (rejectedFile as UploadRejectedFile).filename === "string" &&
          typeof (rejectedFile as UploadRejectedFile).message === "string"
      )
  );
}

export default function Home() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const legacyFileInputRef = useRef<HTMLInputElement>(null);
  const uploadStartedRef = useRef(false);
  const uploadedBatchIndexesRef = useRef<Set<number>>(new Set());
  const [sessionName, setSessionName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [sampleSize, setSampleSize] = useState(10);
  const [concurrency, setConcurrency] = useState("10");
  const [sourceMode, setSourceMode] = useState<SourceMode>("file");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [legacyFiles, setLegacyFiles] = useState<File[]>([]);
  const [folderXmlCount, setFolderXmlCount] = useState<number | null>(null);
  const [sitemapUrlFields, setSitemapUrlFields] = useState<SitemapUrlField[]>(
    () => [createSitemapUrlField("url-1")]
  );
  const [fileError, setFileError] = useState("");
  const [fileRejections, setFileRejections] = useState<UploadRejectedFile[]>([]);
  const [formError, setFormError] = useState("");
  const [queuedSessionId, setQueuedSessionId] = useState<string | null>(null);
  const [queuedFileCount, setQueuedFileCount] = useState<number | null>(null);
  const [baseUrlTouched, setBaseUrlTouched] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isPreviewingUrl, setIsPreviewingUrl] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(
    null
  );
  // Chunked-upload batch progress ("Uploading batch X of Y") — v1.33 Fix 2.
  const [uploadBatchInfo, setUploadBatchInfo] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [uploadStorageText, setUploadStorageText] = useState("");

  const trimmedSessionName = sessionName.trim();
  const trimmedBaseUrl = baseUrl.trim();
  const concurrencyNumber = Number(concurrency);
  const hasValidBaseUrl = trimmedBaseUrl.length > 0 && isHttpBaseUrl(trimmedBaseUrl);
  const expectedUrlHost = hasValidBaseUrl
    ? hostFromHttpUrl(trimmedBaseUrl)
    : null;
  const sitemapUrlFieldStates = sitemapUrlFields.map((field) => {
    const trimmedValue = field.value.trim();
    const normalizedUrl = normalizedHttpUrl(trimmedValue);
    const hasValidUrl =
      trimmedValue.length > 0 && isHttpBaseUrl(trimmedValue);
    const hasMatchingPreview = field.previewSource === normalizedUrl;
    const hasValidPreview = Boolean(
      hasMatchingPreview && field.preview?.is_valid
    );

    return {
      field,
      trimmedValue,
      normalizedUrl,
      hasValidUrl,
      hasMatchingPreview,
      hasValidPreview
    };
  });
  const hasValidUrlPreview = Boolean(
    sitemapUrlFieldStates.length > 0 &&
      sitemapUrlFieldStates.every((fieldState) => fieldState.hasValidPreview)
  );
  const hasValidSource =
    sourceMode === "file" ? selectedFiles.length > 0 : hasValidUrlPreview;
  const hasValidConcurrency =
    Number.isInteger(concurrencyNumber) &&
    concurrencyNumber >= 1 &&
    concurrencyNumber <= 30;
  const canSubmit =
    trimmedSessionName.length > 0 &&
    hasValidBaseUrl &&
    hasValidConcurrency &&
    hasValidSource &&
    !isPreviewingUrl &&
    !isSubmitting;
  const multiFileGuidanceCount =
    queuedSessionId && queuedFileCount !== null
      ? queuedFileCount
      : selectedFiles.length;
  const shouldShowMultiFileGuidance =
    sourceMode === "file" && multiFileGuidanceCount >= 2;
  const shouldShowMultiUrlGuidance =
    sourceMode === "url" && sitemapUrlFields.length >= 2;
  const multiFileGuidanceMessage =
    trimmedBaseUrl.length === 0
      ? "Please enter the Base URL first so we can validate your files."
      : `You are uploading ${multiFileGuidanceCount} sitemaps. All files will be analysed together as one session. Make sure all sitemaps belong to the same site (${trimmedBaseUrl}).`;
  const multiUrlGuidanceMessage =
    trimmedBaseUrl.length === 0
      ? "Please enter the Base URL first so we can validate your URLs."
      : `You are fetching ${sitemapUrlFields.length} sitemaps. All must belong to ${trimmedBaseUrl}.`;

  useEffect(() => {
    prepareFolderPickerInput(folderInputRef.current);
  }, []);

  useEffect(() => {
    let isCancelled = false;

    async function loadDiskUsage() {
      try {
        const usage = await getSystemDiskUsage();

        if (!isCancelled) {
          setUploadStorageText(formatStorageSize(usage.upload_storage_mb));
        }
      } catch {
        if (!isCancelled) {
          setUploadStorageText("");
        }
      }
    }

    void loadDiskUsage();

    return () => {
      isCancelled = true;
    };
  }, []);

  const baseUrlError = useMemo(() => {
    if (!baseUrlTouched || trimmedBaseUrl.length === 0 || hasValidBaseUrl) {
      return "";
    }

    return "Base URL must start with http:// or https://";
  }, [baseUrlTouched, hasValidBaseUrl, trimmedBaseUrl.length]);

  function addSitemapFiles(nextFiles: File[], source: "files" | "folder") {
    setFormError("");
    setFileRejections([]);
    setQueuedSessionId(null);
    setQueuedFileCount(null);
    setUploadProgress(null);

    if (nextFiles.length === 0) {
      return;
    }

    const xmlFiles = nextFiles.filter(isXmlFile);

    if (source === "folder") {
      setFolderXmlCount(xmlFiles.length);

      if (xmlFiles.length === 0) {
        setFileError("No XML files were found in this folder.");
        return;
      }

    } else {
      setFolderXmlCount(null);

      if (xmlFiles.length === 0) {
        setFileError("Please upload .xml files only.");
        return;
      }

      if (xmlFiles.length < nextFiles.length) {
        setFileError("Only .xml files were added.");
      } else {
        setFileError("");
      }
    }

    const currentFileKeys = new Set(selectedFiles.map(selectedFileKey));
    const addedFileCount = xmlFiles.filter(
      (xmlFile) => !currentFileKeys.has(selectedFileKey(xmlFile))
    ).length;

    if (
      addedFileCount > 0 &&
      !confirmLargeUpload(selectedFiles.length + addedFileCount)
    ) {
      if (source === "folder") {
        setFolderXmlCount(null);
      }

      return;
    }

    setSourceMode("file");
    setSelectedFiles((currentFiles) => {
      const nextSelectedFiles = [...currentFiles];
      const seenKeys = new Set(currentFiles.map(selectedFileKey));

      for (const xmlFile of xmlFiles) {
        const key = selectedFileKey(xmlFile);

        if (!seenKeys.has(key)) {
          nextSelectedFiles.push(xmlFile);
          seenKeys.add(key);
        }
      }

      return nextSelectedFiles;
    });

    if (source === "folder") {
      setFileError("");
    }
  }

  function addLegacySitemapFiles(nextFiles: File[]) {
    setFormError("");
    setFileRejections([]);
    setQueuedSessionId(null);
    setQueuedFileCount(null);
    setUploadProgress(null);

    if (nextFiles.length === 0) {
      return;
    }

    const xmlFiles = nextFiles.filter(isXmlFile);

    if (xmlFiles.length === 0) {
      setFileError("Please upload .xml files only.");
      return;
    }

    if (xmlFiles.length < nextFiles.length) {
      setFileError("Only .xml legacy files were added.");
    } else {
      setFileError("");
    }

    const currentLegacyFileKeys = new Set(legacyFiles.map(selectedFileKey));
    const addedLegacyFileCount = xmlFiles.filter(
      (xmlFile) => !currentLegacyFileKeys.has(selectedFileKey(xmlFile))
    ).length;

    if (
      addedLegacyFileCount > 0 &&
      !confirmLargeUpload(
        selectedFiles.length + legacyFiles.length + addedLegacyFileCount
      )
    ) {
      return;
    }

    setSourceMode("file");
    setLegacyFiles((currentFiles) => {
      const nextSelectedFiles = [...currentFiles];
      const seenKeys = new Set(currentFiles.map(selectedFileKey));

      for (const xmlFile of xmlFiles) {
        const key = selectedFileKey(xmlFile);

        if (!seenKeys.has(key)) {
          nextSelectedFiles.push(xmlFile);
          seenKeys.add(key);
        }
      }

      return nextSelectedFiles;
    });
  }

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);

    addSitemapFiles(files, "files");
    event.currentTarget.value = "";
  }

  function handleFolderInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);

    addSitemapFiles(files, "folder");
    event.currentTarget.value = "";
  }

  function handleLegacyFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);

    addLegacySitemapFiles(files);
    event.currentTarget.value = "";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);

    const files = Array.from(event.dataTransfer.files);

    addSitemapFiles(files, "files");
  }

  function openFilePicker() {
    setSourceMode("file");
    fileInputRef.current?.click();
  }

  function openFolderPicker() {
    setSourceMode("file");
    const folderInput = folderInputRef.current;

    prepareFolderPickerInput(folderInput);
    folderInput?.click();
  }

  function removeSelectedFile(fileToRemove: File) {
    setSelectedFiles((currentFiles) =>
      currentFiles.filter(
        (currentFile) =>
          selectedFileKey(currentFile) !== selectedFileKey(fileToRemove)
      )
    );
    setFolderXmlCount(null);
    setFormError("");
    setFileRejections([]);
    setQueuedSessionId(null);
    setQueuedFileCount(null);
    setUploadProgress(null);
  }

  function removeLegacyFile(fileToRemove: File) {
    setLegacyFiles((currentFiles) =>
      currentFiles.filter(
        (currentFile) =>
          selectedFileKey(currentFile) !== selectedFileKey(fileToRemove)
      )
    );
    setFormError("");
    setFileRejections([]);
    setQueuedSessionId(null);
    setQueuedFileCount(null);
    setUploadProgress(null);
  }

  function resetUrlSubmissionState() {
    setFormError("");
    setFileRejections([]);
    setQueuedSessionId(null);
    setQueuedFileCount(null);
    setUploadProgress(null);
  }

  function handleSitemapUrlChange(fieldId: string, value: string) {
    setSourceMode("url");
    setSitemapUrlFields((currentFields) =>
      currentFields.map((field) =>
        field.id === fieldId
          ? {
              ...clearSitemapUrlPreview(field),
              value
            }
          : field
      )
    );
    resetUrlSubmissionState();
  }

  function handleSitemapUrlBlur(fieldId: string) {
    setSitemapUrlFields((currentFields) =>
      currentFields.map((field) =>
        field.id === fieldId
          ? {
              ...field,
              touched: true
            }
          : field
      )
    );
  }

  function addSitemapUrlField() {
    if (sitemapUrlFields.length >= MAX_SITEMAP_URL_FIELDS) {
      return;
    }

    setSourceMode("url");
    setSitemapUrlFields((currentFields) => [
      ...currentFields,
      createSitemapUrlField()
    ]);
    resetUrlSubmissionState();
  }

  function removeSitemapUrlField(fieldId: string) {
    if (sitemapUrlFields.length === 1) {
      return;
    }

    setSitemapUrlFields((currentFields) =>
      currentFields.filter((field) => field.id !== fieldId)
    );
    resetUrlSubmissionState();
  }

  function handleTryDifferentUrl() {
    setSourceMode("url");
    setSitemapUrlFields([createSitemapUrlField("url-1")]);
    resetUrlSubmissionState();
  }

  function sitemapUrlValidationMessage(value: string) {
    const trimmedValue = value.trim();

    if (trimmedValue.length === 0) {
      return "Enter a sitemap URL.";
    }

    if (!isHttpBaseUrl(trimmedValue)) {
      return "Sitemap URL must start with http:// or https://";
    }

    if (!hasValidBaseUrl || !expectedUrlHost) {
      return "Enter the Base URL first so this sitemap can be validated.";
    }

    const detectedHost = hostFromHttpUrl(trimmedValue);

    if (!detectedHost) {
      return "Enter a valid HTTP or HTTPS sitemap URL.";
    }

    if (detectedHost !== expectedUrlHost) {
      return `This sitemap URL belongs to ${detectedHost}, not ${expectedUrlHost}. All sitemap URLs must match the Base URL.`;
    }

    return "";
  }

  async function handlePreviewSitemapUrl() {
    setSourceMode("url");
    setFormError("");
    setBaseUrlTouched(true);

    const validatedFields = sitemapUrlFields.map((field) => {
      const error = sitemapUrlValidationMessage(field.value);

      return {
        field,
        error,
        normalizedUrl: normalizedHttpUrl(field.value.trim())
      };
    });
    const fieldsToPreview = validatedFields.filter(
      (validatedField) => !validatedField.error
    );

    setSitemapUrlFields((currentFields) =>
      currentFields.map((field) => {
        const validatedField = validatedFields.find(
          (candidate) => candidate.field.id === field.id
        );

        return {
          ...field,
          touched: true,
          preview: null,
          previewSource: "",
          error: validatedField?.error ?? ""
        };
      })
    );

    if (fieldsToPreview.length === 0) {
      return;
    }

    setIsPreviewingUrl(true);

    try {
      const previewResults = await Promise.all(
        fieldsToPreview.map(async ({ field, normalizedUrl }) => {
          try {
            const preview = await previewSitemapUrl(field.value.trim());

            return {
              fieldId: field.id,
              normalizedUrl,
              preview,
              error: preview.is_valid ? "" : SITEMAP_URL_FETCH_ERROR
            };
          } catch {
            return {
              fieldId: field.id,
              normalizedUrl,
              preview: null,
              error: SITEMAP_URL_FETCH_ERROR
            };
          }
        })
      );

      setSitemapUrlFields((currentFields) =>
        currentFields.map((field) => {
          const previewResult = previewResults.find(
            (candidate) => candidate.fieldId === field.id
          );

          if (!previewResult) {
            return field;
          }

          return {
            ...field,
            preview: previewResult.preview,
            previewSource: previewResult.preview
              ? previewResult.normalizedUrl
              : "",
            error: previewResult.error
          };
        })
      );
    } finally {
      setIsPreviewingUrl(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (uploadStartedRef.current) {
      return;
    }

    uploadStartedRef.current = true;
    setBaseUrlTouched(true);
    setFormError("");
    setFileRejections([]);
    setQueuedSessionId(null);
    setQueuedFileCount(null);

    if (!canSubmit) {
      if (sourceMode === "file" && selectedFiles.length === 0) {
        setFormError("Choose at least one XML file before starting analysis.");
      } else if (sourceMode === "url" && !hasValidUrlPreview) {
        setFormError("Preview every sitemap URL before starting analysis.");
      } else {
        setFormError("Complete the required fields before starting analysis.");
      }

      uploadStartedRef.current = false;
      return;
    }

    const confirmedSitemapUrls =
      sourceMode === "url"
        ? sitemapUrlFieldStates
            .filter(
              (fieldState) =>
                fieldState.hasValidPreview && fieldState.field.preview
            )
            .map((fieldState) => ({
              sitemapUrl: fieldState.normalizedUrl,
              filename: fieldState.field.preview!.filename
            }))
        : [];

    if (
      sourceMode === "url" &&
      confirmedSitemapUrls.length !== sitemapUrlFields.length
    ) {
      setFormError("Preview every sitemap URL before starting analysis.");
      uploadStartedRef.current = false;
      return;
    }

    const uploadFileCount = selectedFiles.length + legacyFiles.length;

    setIsSubmitting(true);

    try {
      const created = await createSession({
        name: trimmedSessionName,
        baseUrl: trimmedBaseUrl,
        sampleSize,
        concurrency: concurrencyNumber
      });

      if (sourceMode === "file" && selectedFiles.length > 0) {
        setUploadProgress({
          loadedBytes: 0,
          totalBytes: 0,
          transferredFiles: 0,
          totalFiles: uploadFileCount,
          percent: 0
        });
        const uploadBatches = [
          ...chunkFiles(selectedFiles, UPLOAD_BATCH_SIZE).map((files) => ({
            files,
            legacyFiles: [] as File[]
          })),
          ...chunkFiles(legacyFiles, UPLOAD_BATCH_SIZE).map((files) => ({
            files: [] as File[],
            legacyFiles: files
          }))
        ];
        const rejectedFiles: UploadRejectedFile[] = [];
        let acceptedCount = 0;
        let transferredFiles = 0;
        let completedBatches = 0;

        uploadedBatchIndexesRef.current = new Set();
        setUploadBatchInfo({ done: 0, total: uploadBatches.length });

        // Send up to MAX_CONCURRENT_UPLOADS batches at once. Each worker pulls
        // the next un-uploaded batch index off a shared cursor until they run
        // out. `nextBatch++` is a single synchronous step, so no two workers
        // grab the same batch. Progress updates as each batch completes.
        let nextBatch = 0;
        const uploadWorker = async () => {
          for (;;) {
            const batchIndex = nextBatch;
            nextBatch += 1;

            if (batchIndex >= uploadBatches.length) {
              return;
            }

            // Skip batches already uploaded by a previous attempt (retry).
            if (uploadedBatchIndexesRef.current.has(batchIndex)) {
              continue;
            }

            const batch = uploadBatches[batchIndex];
            const batchFileCount =
              batch.files.length + batch.legacyFiles.length;
            const uploadResult = await uploadSitemap(
              created.session_id,
              batch.files,
              batch.legacyFiles
            );

            uploadedBatchIndexesRef.current.add(batchIndex);
            acceptedCount += uploadResult.sitemap_files?.length ?? 0;
            rejectedFiles.push(...(uploadResult.rejected_files ?? []));
            transferredFiles += batchFileCount;
            completedBatches += 1;

            setUploadBatchInfo({
              done: completedBatches,
              total: uploadBatches.length
            });
            setUploadProgress({
              loadedBytes: 0,
              totalBytes: 0,
              transferredFiles,
              totalFiles: uploadFileCount,
              percent:
                uploadFileCount === 0
                  ? 0
                  : Math.round((transferredFiles / uploadFileCount) * 100)
            });
          }
        };

        await Promise.all(
          Array.from(
            { length: Math.min(MAX_CONCURRENT_UPLOADS, uploadBatches.length) },
            () => uploadWorker()
          )
        );

        await completeSitemapUpload(created.session_id);

        if (rejectedFiles.length > 0) {
          setFileRejections(rejectedFiles);

          if (acceptedCount > 0) {
            setQueuedSessionId(created.session_id);
            setQueuedFileCount(acceptedCount);
            setFormError(
              `${acceptedCount} sitemap file${
                acceptedCount === 1 ? "" : "s"
              } queued. ${rejectedFiles.length} file${
                rejectedFiles.length === 1 ? "" : "s"
              } rejected.`
            );
            uploadStartedRef.current = false;
            setIsSubmitting(false);
            return;
          }
        }
      } else if (confirmedSitemapUrls.length > 0) {
        await submitSitemapUrls(created.session_id, confirmedSitemapUrls);
      } else {
        throw new Error("Preview every sitemap URL before starting analysis.");
      }

      router.push(`/sessions/${created.session_id}`);
    } catch (error) {
      const rejectedFiles = uploadRejectionsFromPayload(apiErrorPayload(error));

      if (rejectedFiles.length > 0) {
        setFileRejections(rejectedFiles);
      }

      setFormError(friendlyApiErrorMessage(error, "Unable to start analysis."));
      setUploadProgress(null);
      setUploadBatchInfo(null);
      uploadedBatchIndexesRef.current = new Set();
      uploadStartedRef.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-[calc(100vh-56px)] bg-[#F8FAFC]">
      <section className="mx-auto flex w-full max-w-5xl flex-col items-center px-4 py-8 sm:px-6 lg:px-8">
        <div className="w-full rounded-2xl bg-gradient-to-br from-slate-900 via-slate-900 to-indigo-950 px-6 py-10 text-center shadow-lg shadow-slate-900/10 sm:px-10">
          <Badge className="mb-4 rounded-full border-emerald-400/20 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/10">
            Local SEO audit
          </Badge>
          <h1 className="mx-auto max-w-3xl text-3xl font-bold tracking-normal text-white sm:text-4xl">
            Check your sitemap migration health
          </h1>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-slate-300 sm:text-base">
            Upload a sitemap or paste a URL to analyse URL patterns and verify live pages.
          </p>
        </div>

        <div className="-mt-8 w-full max-w-[680px] pb-10">
          <Card className="w-full rounded-xl border border-slate-200 bg-white shadow-md shadow-slate-900/10">
            <CardHeader className="px-8 pb-4 pt-8">
              <CardTitle className="text-2xl font-bold text-slate-900">
                Upload sitemap
              </CardTitle>
              <CardDescription className="text-sm text-slate-500">
                Create a session from XML files or sitemap URLs.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-8 pb-8 pt-0">
              <form className="space-y-6" onSubmit={handleSubmit}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <label
                      htmlFor="session-name"
                      className="text-sm font-semibold text-slate-700"
                    >
                      Session name
                    </label>
                    <Input
                      id="session-name"
                      value={sessionName}
                      onChange={(event) => setSessionName(event.target.value)}
                      placeholder="July migration audit"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <label
                      htmlFor="base-url"
                      className="text-sm font-semibold text-slate-700"
                    >
                      Base URL
                    </label>
                    <Input
                      id="base-url"
                      value={baseUrl}
                      onBlur={() => setBaseUrlTouched(true)}
                      onChange={(event) => {
                        setBaseUrl(event.target.value);
                        setSitemapUrlFields((currentFields) =>
                          currentFields.map(clearSitemapUrlPreview)
                        );
                        setFileRejections([]);
                        setQueuedSessionId(null);
                        setQueuedFileCount(null);
                        setUploadProgress(null);
                      }}
                      placeholder="https://yoursite.com"
                      required
                    />
                    {baseUrlError ? (
                      <p className="text-sm text-red-500">{baseUrlError}</p>
                    ) : null}
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <label
                      htmlFor="sample-size"
                      className="text-sm font-semibold text-slate-700"
                    >
                      Sample size
                    </label>
                    <select
                      id="sample-size"
                      value={sampleSize}
                      onChange={(event) => setSampleSize(Number(event.target.value))}
                      className="flex h-10 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1"
                    >
                      {sampleSizeOptions.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-2">
                    <label
                      htmlFor="concurrency"
                      className="text-sm font-semibold text-slate-700"
                    >
                      Max simultaneous checks
                    </label>
                    <Input
                      id="concurrency"
                      type="number"
                      min={1}
                      max={30}
                      value={concurrency}
                      onChange={(event) => setConcurrency(event.target.value)}
                      required
                    />
                    <p className="text-sm text-slate-500">
                      How many URLs are checked at the same time. Default 10 is
                      fine for most sites.
                    </p>
                    {!hasValidConcurrency ? (
                      <p className="text-sm text-red-500">
                        Enter a number from 1 to 30.
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="space-y-3">
                  <label className="text-sm font-semibold text-slate-700">
                    Sitemap source
                  </label>
                  <div
                    className="grid grid-cols-2 gap-1 rounded-full border border-indigo-100 bg-indigo-50 p-1"
                    role="tablist"
                    aria-label="Sitemap source"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={sourceMode === "file"}
                      onClick={() => {
                        setSourceMode("file");
                        setFormError("");
                      }}
                      className={cn(
                        "flex h-10 items-center justify-center gap-2 rounded-full text-sm font-semibold transition-colors",
                        sourceMode === "file"
                          ? "bg-indigo-500 text-white shadow-sm"
                          : "text-slate-500 hover:text-indigo-600"
                      )}
                    >
                      <FileText className="h-4 w-4" aria-hidden="true" />
                      Upload File
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={sourceMode === "url"}
                      onClick={() => {
                        setSourceMode("url");
                        setFormError("");
                      }}
                      className={cn(
                        "flex h-10 items-center justify-center gap-2 rounded-full text-sm font-semibold transition-colors",
                        sourceMode === "url"
                          ? "bg-indigo-500 text-white shadow-sm"
                          : "text-slate-500 hover:text-indigo-600"
                      )}
                    >
                      <LinkIcon className="h-4 w-4" aria-hidden="true" />
                      Enter URL
                    </button>
                  </div>

                  {sourceMode === "file" ? (
                    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                      <div
                        data-testid="sitemap-drop-zone"
                        role="button"
                        tabIndex={0}
                        onClick={openFilePicker}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            openFilePicker();
                          }
                        }}
                        onDragOver={(event) => {
                          event.preventDefault();
                          setSourceMode("file");
                          setIsDragging(true);
                        }}
                        onDragLeave={() => setIsDragging(false)}
                        onDrop={handleDrop}
                        className={cn(
                          "flex min-h-48 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-4 py-7 text-center transition-colors",
                          isDragging
                            ? "border-indigo-400 bg-indigo-100"
                            : "border-indigo-300/70 bg-indigo-50/60 hover:bg-indigo-100/60"
                        )}
                      >
                        <input
                          ref={fileInputRef}
                          data-testid="sitemap-file-input"
                          name="files"
                          type="file"
                          accept=".xml,text/xml,application/xml"
                          multiple={true}
                          className="hidden"
                          onChange={handleFileInputChange}
                        />
                        <input
                          ref={folderInputRef}
                          data-testid="sitemap-folder-input"
                          name="folder"
                          type="file"
                          accept=".xml,text/xml,application/xml"
                          multiple={true}
                          className="hidden"
                          onChange={handleFolderInputChange}
                        />
                        <input
                          ref={legacyFileInputRef}
                          data-testid="legacy-sitemap-file-input"
                          name="legacy_files"
                          type="file"
                          accept=".xml,text/xml,application/xml"
                          multiple={true}
                          className="hidden"
                          onChange={handleLegacyFileInputChange}
                        />
                        {selectedFiles.length > 0 ? (
                          <>
                            <FileText
                              className="h-9 w-9 text-indigo-500"
                              aria-hidden="true"
                            />
                            <div className="mt-4 max-w-full space-y-1">
                              <p className="truncate text-sm font-semibold text-slate-900">
                                {selectedFiles.length} XML files selected
                              </p>
                              <p className="text-sm text-slate-500">
                                Add more files or remove individual entries below
                              </p>
                            </div>
                          </>
                        ) : (
                          <>
                            <UploadCloud
                              className="h-9 w-9 text-indigo-500"
                              aria-hidden="true"
                            />
                            <div className="mt-4 space-y-1">
                              <p className="text-sm font-semibold text-slate-900">
                                Drop XML files here
                              </p>
                              <p className="text-sm text-slate-500">
                                Or browse for one or more .xml files
                              </p>
                            </div>
                          </>
                        )}
                        <div className="mt-5 flex flex-wrap justify-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={(event) => {
                              event.stopPropagation();
                              openFilePicker();
                            }}
                          >
                            Browse file
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={(event) => {
                              event.stopPropagation();
                              openFolderPicker();
                            }}
                          >
                            <FolderOpen
                              className="mr-2 h-4 w-4"
                              aria-hidden="true"
                            />
                            Upload folder
                          </Button>
                        </div>
                      </div>
                      {folderXmlCount !== null ? (
                        <p className="text-sm text-slate-500">
                          Found {folderXmlCount} XML files in folder
                        </p>
                      ) : null}
                      {selectedFiles.length > 0 ? (
                        <div className="rounded-xl border border-slate-200 bg-slate-50">
                          <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
                            <p className="text-sm font-semibold text-slate-700">
                              Selected files
                            </p>
                            <p className="text-sm text-slate-500">
                              {selectedFiles.length} total
                            </p>
                          </div>
                          <ul className="max-h-56 overflow-y-auto">
                            {selectedFiles.map((selectedFile) => (
                              <li
                                key={selectedFileKey(selectedFile)}
                                className="flex min-h-12 items-center gap-3 border-b px-3 py-2 last:border-b-0"
                              >
                                <FileText
                                  className="h-4 w-4 shrink-0 text-indigo-500"
                                  aria-hidden="true"
                                />
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-sm font-medium text-slate-900">
                                    {selectedFileLabel(selectedFile)}
                                  </p>
                                  <p className="text-xs text-slate-500">
                                    {formatFileSize(selectedFile.size)}
                                  </p>
                                </div>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 shrink-0"
                                  aria-label={`Remove ${selectedFileLabel(
                                    selectedFile
                                  )}`}
                                  onClick={() => removeSelectedFile(selectedFile)}
                                >
                                  <X className="h-4 w-4" aria-hidden="true" />
                                </Button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <p className="text-sm font-semibold text-slate-700">
                              Legacy sitemap comparison
                            </p>
                            <p className="text-sm text-slate-500">
                              Optional old sitemap files are compared against the current sitemap patterns.
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                              setSourceMode("file");
                              legacyFileInputRef.current?.click();
                            }}
                          >
                            Browse legacy files
                          </Button>
                        </div>
                        {legacyFiles.length > 0 ? (
                          <div className="mt-3 rounded-xl border border-slate-200 bg-white">
                            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
                              <p className="text-sm font-semibold text-slate-700">
                                Legacy files
                              </p>
                              <p className="text-sm text-slate-500">
                                {legacyFiles.length} total
                              </p>
                            </div>
                            <ul className="max-h-40 overflow-y-auto">
                              {legacyFiles.map((legacyFile) => (
                                <li
                                  key={selectedFileKey(legacyFile)}
                                  className="flex min-h-12 items-center gap-3 border-b px-3 py-2 last:border-b-0"
                                >
                                  <FileText
                                    className="h-4 w-4 shrink-0 text-indigo-500"
                                    aria-hidden="true"
                                  />
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium text-slate-900">
                                      {selectedFileLabel(legacyFile)}
                                    </p>
                                    <p className="text-xs text-slate-500">
                                      {formatFileSize(legacyFile.size)}
                                    </p>
                                  </div>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 shrink-0"
                                    aria-label={`Remove ${selectedFileLabel(
                                      legacyFile
                                    )}`}
                                    onClick={() => removeLegacyFile(legacyFile)}
                                  >
                                    <X className="h-4 w-4" aria-hidden="true" />
                                  </Button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </div>
                      {shouldShowMultiFileGuidance ? (
                        <div
                          className="flex items-start gap-2 rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2 text-sm text-slate-700"
                          role="status"
                        >
                          <Info
                            className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500"
                            aria-hidden="true"
                          />
                          <span>{multiFileGuidanceMessage}</span>
                        </div>
                      ) : null}
                      <UploadRejections
                        rejections={fileRejections}
                        baseUrl={trimmedBaseUrl}
                      />
                      {fileError ? (
                        <p className="text-sm text-red-500">{fileError}</p>
                      ) : null}
                    </div>
                  ) : (
                    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                      <div className="space-y-3">
                        {sitemapUrlFieldStates.map((fieldState, index) => (
                          <div key={fieldState.field.id} className="space-y-2">
                            <div className="flex items-center justify-between gap-3">
                              <label
                                htmlFor={`sitemap-url-${fieldState.field.id}`}
                                className="text-sm font-semibold text-slate-700"
                              >
                                Sitemap URL {index + 1}
                              </label>
                              {sitemapUrlFields.length > 1 ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 px-2"
                                  onClick={() =>
                                    removeSitemapUrlField(fieldState.field.id)
                                  }
                                >
                                  <X
                                    className="mr-1 h-4 w-4"
                                    aria-hidden="true"
                                  />
                                  Remove
                                </Button>
                              ) : null}
                            </div>
                            <Input
                              id={`sitemap-url-${fieldState.field.id}`}
                              value={fieldState.field.value}
                              onFocus={() => setSourceMode("url")}
                              onBlur={() =>
                                handleSitemapUrlBlur(fieldState.field.id)
                              }
                              onChange={(event) =>
                                handleSitemapUrlChange(
                                  fieldState.field.id,
                                  event.target.value
                                )
                              }
                              placeholder="https://www.asapindustrialservices.com/sitemaps/manufacturer.xml"
                            />
                            {fieldState.field.error ? (
                              <p className="text-sm text-red-500">
                                {fieldState.field.error}
                              </p>
                            ) : null}
                          </div>
                        ))}
                      </div>

                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Button
                          type="button"
                          variant="outline"
                          disabled={
                            sitemapUrlFields.length >= MAX_SITEMAP_URL_FIELDS ||
                            isPreviewingUrl ||
                            isSubmitting
                          }
                          onClick={addSitemapUrlField}
                          className="sm:flex-1"
                        >
                          + Add another sitemap URL
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={isPreviewingUrl || isSubmitting}
                          onClick={() => void handlePreviewSitemapUrl()}
                          className="sm:flex-1"
                        >
                          {isPreviewingUrl ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Search className="mr-2 h-4 w-4" />
                          )}
                          Fetch &amp; Preview
                        </Button>
                      </div>

                      {sitemapUrlFields.length >= MAX_SITEMAP_URL_FIELDS ? (
                        <p className="text-sm text-slate-500">
                          Maximum of {MAX_SITEMAP_URL_FIELDS} sitemap URLs reached.
                        </p>
                      ) : null}

                      {shouldShowMultiUrlGuidance ? (
                        <div
                          className="flex items-start gap-2 rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2 text-sm text-slate-700"
                          role="status"
                        >
                          <Info
                            className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500"
                            aria-hidden="true"
                          />
                          <span>{multiUrlGuidanceMessage}</span>
                        </div>
                      ) : null}

                      {sitemapUrlFieldStates.some(
                        (fieldState) => fieldState.hasValidPreview
                      ) ? (
                        <div className="space-y-3">
                          {sitemapUrlFieldStates
                            .filter((fieldState) => fieldState.hasValidPreview)
                            .map((fieldState, index) => {
                              const preview = fieldState.field.preview!;

                              return (
                                <div
                                  key={`${fieldState.field.id}:${preview.filename}`}
                                  className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
                                  role="status"
                                >
                                  <div className="flex items-start gap-2">
                                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                                    <div className="min-w-0">
                                      <p className="font-medium">
                                        Preview ready for URL {index + 1}
                                      </p>
                                      <p className="break-all text-xs text-emerald-800">
                                        {fieldState.normalizedUrl}
                                      </p>
                                    </div>
                                  </div>
                                  <dl className="mt-3 grid gap-3 sm:grid-cols-3">
                                    <div>
                                      <dt className="text-xs font-medium uppercase text-emerald-700">
                                        File name
                                      </dt>
                                      <dd className="mt-1 break-all font-medium">
                                        {preview.filename}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt className="text-xs font-medium uppercase text-emerald-700">
                                        Total URLs found
                                      </dt>
                                      <dd className="mt-1 font-medium">
                                        {formatCount(preview.total_urls)}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt className="text-xs font-medium uppercase text-emerald-700">
                                        Sitemap index
                                      </dt>
                                      <dd className="mt-1 font-medium">
                                        {preview.is_index ? "Yes" : "No"}
                                      </dd>
                                    </div>
                                  </dl>
                                  <div className="mt-3 space-y-1">
                                    <p className="text-xs font-medium uppercase text-emerald-700">
                                      Top detected URL patterns
                                    </p>
                                    {preview.preview_patterns.length > 0 ? (
                                      <ul className="list-inside list-disc space-y-1">
                                        {preview.preview_patterns
                                          .slice(0, 3)
                                          .map((pattern) => (
                                            <li
                                              key={pattern}
                                              className="break-all"
                                            >
                                              {pattern}
                                            </li>
                                          ))}
                                      </ul>
                                    ) : (
                                      <p>No URL patterns detected.</p>
                                    )}
                                  </div>
                                  {preview.had_preamble_stripped ? (
                                    <p className="mt-3">
                                      Extra text before XML will be cleaned
                                      automatically.
                                    </p>
                                  ) : null}
                                </div>
                              );
                            })}
                        </div>
                      ) : null}

                      {hasValidUrlPreview ? (
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <Button
                            type="submit"
                            disabled={!canSubmit}
                            className="sm:flex-1"
                          >
                            {isSubmitting ? (
                              <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                Starting
                              </>
                            ) : (
                              <>
                                <CheckCircle2 className="mr-2 h-4 w-4" />
                                Looks good - Start Analysis
                              </>
                            )}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            disabled={isSubmitting}
                            className="border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50"
                            onClick={handleTryDifferentUrl}
                          >
                            Try different URLs
                          </Button>
                        </div>
                      ) : null}

                    </div>
                  )}
                </div>

                {uploadProgress ? (
                  <div
                    className="space-y-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-3 text-sm text-slate-700"
                    role="status"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span>
                        {uploadBatchInfo && uploadBatchInfo.total > 1
                          ? `Uploading batch ${Math.min(
                              uploadBatchInfo.done + 1,
                              uploadBatchInfo.total
                            )} of ${uploadBatchInfo.total}... `
                          : "Uploading files... "}
                        {uploadProgress.transferredFiles} of{" "}
                        {uploadProgress.totalFiles} transferred
                      </span>
                      <span className="font-medium text-slate-900">
                        {Math.round(uploadProgress.percent)}%
                      </span>
                    </div>
                    <Progress
                      value={uploadProgress.percent}
                      className="bg-sky-100"
                      indicatorClassName="bg-sky-500"
                    />
                  </div>
                ) : null}

                {formError ? (
                  <div
                    className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600"
                    role="alert"
                  >
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{formError}</span>
                  </div>
                ) : null}

                {queuedSessionId ? (
                  <div className="rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2 text-sm text-slate-700">
                    <span>Accepted files are being processed.</span>
                  </div>
                ) : null}

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-1 text-sm text-slate-500">
                    <p>Session data is processed by the configured backend.</p>
                    {uploadStorageText ? (
                      <p className="text-xs">
                        Upload storage used: {uploadStorageText}
                      </p>
                    ) : null}
                  </div>
                  {sourceMode === "url" && hasValidUrlPreview ? null : queuedSessionId ? (
                    <Button
                      type="button"
                      className="sm:w-44"
                      onClick={() => router.push(`/sessions/${queuedSessionId}`)}
                    >
                      View analysis
                    </Button>
                  ) : (
                    <Button type="submit" disabled={!canSubmit} className="w-full sm:w-44">
                      {isSubmitting ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Starting
                        </>
                      ) : (
                        "Start Analysis"
                      )}
                    </Button>
                  )}
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      </section>
    </main>
  );
}
