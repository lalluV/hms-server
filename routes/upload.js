const express = require("express");
const multer = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { v4: uuidv4 } = require("uuid");
const dotenv = require("dotenv");
const FileMerger = require("../utils/fileMerger");

dotenv.config();

const router = express.Router();
const { applyEntitlementsNoTenantDb } = require("../utils/applyTenantEntitlements");

applyEntitlementsNoTenantDb(router, { moduleKey: "core", useAuth: "flexible" });

// Configure multer for memory storage with multiple files
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit per file
    files: 10, // Maximum 10 files per upload
  },
});

// Configure S3 client for Cloudflare R2
const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// Initialize file merger
const fileMerger = new FileMerger();

// Test endpoint to verify the route is working
router.get("/test-consent", (req, res) => {
  res.json({
    message: "Consent upload route is working",
    timestamp: new Date().toISOString(),
  });
});

// Handle signature upload
router.post("/signature", upload.single("signature"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No signature file uploaded" });
    }

    const { employeeId } = req.body;
    if (!employeeId) {
      return res.status(400).json({ error: "Employee ID is required" });
    }

    // Validate file type
    if (!req.file.mimetype.startsWith("image/")) {
      return res
        .status(400)
        .json({ error: "Only image files are allowed for signatures" });
    }

    // Validate file size (max 5MB)
    if (req.file.size > 5 * 1024 * 1024) {
      return res
        .status(400)
        .json({ error: "Signature file size should be less than 5MB" });
    }

    // Generate a unique filename for the signature
    const fileExtension = req.file.originalname.split(".").pop();
    const fileName = `${
      req.hospitalId
    }/signatures/${employeeId}/${uuidv4()}.${fileExtension}`;

    // Upload to R2
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileName,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    });

    await s3Client.send(command);

    // Generate the public URL
    const fileUrl = `${process.env.R2_PUBLIC_URL}/${fileName}`;

    res.json({
      success: true,
      fileUrl,
      message: "Signature uploaded successfully",
      fileInfo: {
        originalName: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
      },
    });
  } catch (error) {
    console.error("Error uploading signature:", error);
    res.status(500).json({
      error: "Failed to upload signature",
      details: error.message,
    });
  }
});

// Handle employee photo upload
router.post("/photo", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No photo file uploaded" });
    }

    const { employeeId } = req.body;
    if (!employeeId) {
      return res.status(400).json({ error: "Employee ID is required" });
    }

    if (!req.file.mimetype.startsWith("image/")) {
      return res
        .status(400)
        .json({ error: "Only image files are allowed for photos" });
    }

    if (req.file.size > 5 * 1024 * 1024) {
      return res
        .status(400)
        .json({ error: "Photo file size should be less than 5MB" });
    }

    const fileExtension = req.file.originalname.split(".").pop();
    const fileName = `${
      req.hospitalId
    }/employees/${employeeId}/${uuidv4()}.${fileExtension}`;

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileName,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    });

    await s3Client.send(command);

    const fileUrl = `${process.env.R2_PUBLIC_URL}/${fileName}`;

    res.json({
      success: true,
      fileUrl,
      message: "Employee photo uploaded successfully",
      fileInfo: {
        originalName: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
      },
    });
  } catch (error) {
    console.error("Error uploading employee photo:", error);
    res.status(500).json({
      error: "Failed to upload photo",
      details: error.message,
    });
  }
});

// Handle hospital logo upload (Admin / SuperAdmin)
router.post("/hospital-logo", upload.single("logo"), async (req, res) => {
  try {
    if (!req.hospitalId) {
      return res.status(400).json({ error: "Hospital ID is required" });
    }

    if (req.user) {
      const { normalizeRole } = require("../config/rolePermissions");
      const role = normalizeRole(req.user.type);
      if (role !== "SuperAdmin" && role !== "Admin") {
        return res.status(403).json({
          error: "Only Admin or Super Admin can upload the hospital logo",
        });
      }
    } else if (!req.isAdmin) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No logo file uploaded" });
    }

    if (!req.file.mimetype.startsWith("image/")) {
      return res
        .status(400)
        .json({ error: "Only image files are allowed for the hospital logo" });
    }

    if (req.file.size > 5 * 1024 * 1024) {
      return res
        .status(400)
        .json({ error: "Logo file size should be less than 5MB" });
    }

    const fileExtension = req.file.originalname.split(".").pop();
    const fileName = `${
      req.hospitalId
    }/branding/logo/${uuidv4()}.${fileExtension}`;

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileName,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    });

    await s3Client.send(command);

    const fileUrl = `${process.env.R2_PUBLIC_URL}/${fileName}`;

    res.json({
      success: true,
      fileUrl,
      message: "Hospital logo uploaded successfully",
      fileInfo: {
        originalName: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
      },
    });
  } catch (error) {
    console.error("Error uploading hospital logo:", error);
    res.status(500).json({
      error: "Failed to upload hospital logo",
      details: error.message,
    });
  }
});

// Handle stamp upload
router.post("/stamp", upload.single("stamp"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No stamp file uploaded" });
    }

    const { name, description, department, category, createdBy } = req.body;
    if (!name || !department || !category || !createdBy) {
      return res.status(400).json({
        error: "Missing required fields: name, department, category, createdBy",
      });
    }

    // Validate file type
    if (!req.file.mimetype.startsWith("image/")) {
      return res
        .status(400)
        .json({ error: "Only image files are allowed for stamps" });
    }

    // Validate file size (max 10MB)
    if (req.file.size > 10 * 1024 * 1024) {
      return res
        .status(400)
        .json({ error: "Stamp file size should be less than 10MB" });
    }

    // Generate a unique filename for the stamp
    const fileExtension = req.file.originalname.split(".").pop();
    const fileName = `${
      req.hospitalId
    }/stamps/${department}/${category}/${uuidv4()}.${fileExtension}`;

    // Upload to R2
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileName,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    });

    await s3Client.send(command);

    // Generate the public URL
    const fileUrl = `${process.env.R2_PUBLIC_URL}/${fileName}`;

    res.json({
      success: true,
      fileUrl,
      message: "Stamp uploaded successfully",
      fileInfo: {
        originalName: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
        name,
        description,
        department,
        category,
        createdBy,
      },
    });
  } catch (error) {
    console.error("Error uploading stamp:", error);
    res.status(500).json({
      error: "Failed to upload stamp",
      details: error.message,
    });
  }
});

// Handle multiple file upload and merge
router.post(
  ["/upload-report", "/report"],
  upload.array("files", 10),
  async (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "No files uploaded" });
      }

      const { receiptId, testId } = req.body;
      if (!receiptId || !testId) {
        return res.status(400).json({ error: "Missing receiptId or testId" });
      }

      console.log(
        `Processing ${req.files.length} files for receipt ${receiptId}, test ${testId}`
      );

      // Validate files
      const validFiles = fileMerger.validateFiles(req.files);
      console.log("Valid files:", fileMerger.getFileInfo(validFiles));

      // Merge files into single PDF
      console.log("Starting file merge process...");
      const mergedPdfBuffer = await fileMerger.mergeFilesToPdf(validFiles);
      console.log(
        "Files merged successfully, PDF size:",
        mergedPdfBuffer.length,
        "bytes"
      );

      // Generate a unique filename for the merged PDF
      const hospitalKey =
        req.hospitalId ||
        req.headers["x-hospital-code"] ||
        req.headers["x-hospital-id"] ||
        "reports";
      const fileName = `${hospitalKey}/${receiptId}/${testId}/merged_${uuidv4()}.pdf`;

    // Upload merged PDF to R2
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileName,
      Body: mergedPdfBuffer,
      ContentType: "application/pdf",
    });

    await s3Client.send(command);
    console.log("Merged PDF uploaded to R2 successfully");

    // Generate the public URL
    const fileUrl = `${process.env.R2_PUBLIC_URL}/${fileName}`;

    // Extract full clinical content from the uploaded report via AI (OpenAI GPT-5.6-Luna / Gemini)
    let textReport = "";
    let impression = "";
    let modality = "";
    try {
      if (mergedPdfBuffer && mergedPdfBuffer.length > 0) {
        const extracted = await extractClinicalReportWithAi({
          buffer: mergedPdfBuffer,
          originalname: `${receiptId}_${testId}.pdf`,
          mimetype: "application/pdf",
        });
        textReport = extracted.textReport || "";
        impression = extracted.impression || "";
        modality = extracted.modality || "";
      }
    } catch (ocrErr) {
      console.warn(
        "AI report extraction error (non-fatal, file still uploaded):",
        ocrErr.message
      );
    }

    res.json({
      success: true,
      fileUrl,
      textReport,
      reportContent: textReport,
      impression,
      modality,
      message: `Successfully merged ${validFiles.length} files into single PDF`,
      fileInfo: {
        originalFiles: fileMerger.getFileInfo(validFiles),
        mergedPdfSize: mergedPdfBuffer.length,
        totalPages: await getPdfPageCount(mergedPdfBuffer),
      },
    });
  } catch (error) {
    console.error("Error processing file upload:", error);
    res.status(500).json({
      error: "Failed to process files",
      details: error.message,
    });
  }
});

/**
 * Clinical report text extraction engine.
 * Primary: OpenAI GPT-5.6-Luna
 * Fallback: Google Gemini 3.6 Flash
 */
async function extractClinicalReportWithAi({ buffer, originalname, mimetype }) {
  if (!buffer || buffer.length === 0) {
    return { textReport: "", impression: "", modality: "" };
  }

  const prompt = `You are a clinical OCR and diagnostic data extraction specialist for an Indian hospital EMR.
Carefully read the attached diagnostic/radiology/laboratory report document.
Extract the FULL, comprehensive report text, preserving clinical structure, anatomical findings, measurements, technique, and impression.

Return valid JSON with this exact shape:
{
  "fullReportText": "Complete formatted report text with clear sections (e.g. CLINICAL INDICATION, TECHNIQUE, OBSERVATIONS/FINDINGS, IMPRESSION/CONCLUSION)",
  "impression": "The concluding clinical impression or diagnosis summary (1-3 sentences)",
  "modality": "Modality or investigation name (e.g., Ultrasound Abdomen, Chest X-Ray, CT Brain, MRI Lumbar Spine, etc.)"
}`;

  // 1. Primary: OpenAI GPT-5.6-Luna
  if (process.env.OPENAI_API_KEY) {
    let fileId = null;
    try {
      console.log(
        `[AI Extract] Calling OpenAI gpt-5.6-luna for ${originalname || "document.pdf"} (${buffer.length} bytes)...`
      );
      const axios = require("axios");
      const FormData = require("form-data");

      const form = new FormData();
      form.append("file", buffer, {
        filename: originalname || "document.pdf",
        contentType: mimetype || "application/pdf",
      });
      form.append("purpose", "user_data");

      const uploadRes = await axios.post("https://api.openai.com/v1/files", form, {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          ...form.getHeaders(),
        },
        timeout: 45000,
      });

      fileId = uploadRes.data?.id;
      console.log(`[AI Extract] Uploaded file to OpenAI with id: ${fileId}`);

      const chatRes = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-5.6-luna",
          response_format: { type: "json_object" },
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "file", file: { file_id: fileId } },
              ],
            },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 90000,
        }
      );

      const rawJson = chatRes.data?.choices?.[0]?.message?.content || "";
      if (rawJson) {
        const parsed = JSON.parse(rawJson);
        console.log(
          `[AI Extract] gpt-5.6-luna extraction successful (${parsed.fullReportText?.length || 0} chars)`
        );
        return {
          textReport: parsed.fullReportText || "",
          impression: parsed.impression || "",
          modality: parsed.modality || "",
          modelUsed: "gpt-5.6-luna",
        };
      }
    } catch (openAiErr) {
      console.warn(
        "[AI Extract] OpenAI gpt-5.6-luna error:",
        openAiErr.response?.data || openAiErr.message
      );
    } finally {
      if (fileId) {
        try {
          const axios = require("axios");
          await axios.delete(`https://api.openai.com/v1/files/${fileId}`, {
            headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          });
          console.log(`[AI Extract] Cleaned up temporary OpenAI file: ${fileId}`);
        } catch (delErr) {
          console.warn(`[AI Extract] Failed to clean up OpenAI file ${fileId}:`, delErr.message);
        }
      }
    }
  }

  // 2. Fallback: Google Gemini 3.6 Flash
  if (process.env.GEMINI_API_KEY) {
    try {
      console.log("[AI Extract] Using Gemini 3.6 Flash...");
      const { GoogleGenAI } = require("@google/genai");
      const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const base64Doc = buffer.toString("base64");

      const aiResponse = await client.models.generateContent({
        model: "gemini-3.6-flash",
        config: {
          responseMimeType: "application/json",
          temperature: 0.1,
        },
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: mimetype === "application/pdf" ? "application/pdf" : mimetype,
                  data: base64Doc,
                },
              },
              {
                text: prompt,
              },
            ],
          },
        ],
      });

      const rawAiText = aiResponse?.text || "";
      if (rawAiText) {
        const parsedAi = JSON.parse(rawAiText);
        console.log(
          `[AI Extract] Gemini extraction successful (${parsedAi.fullReportText?.length || 0} chars)`
        );
        return {
          textReport: parsedAi.fullReportText || "",
          impression: parsedAi.impression || "",
          modality: parsedAi.modality || "",
          modelUsed: "gemini-3.6-flash",
        };
      }
    } catch (geminiErr) {
      console.error("[AI Extract] Gemini fallback failed:", geminiErr.message);
    }
  }

  return { textReport: "", impression: "", modality: "" };
}

// Extract text from uploaded single PDF (without saving to cloud)
router.post(
  ["/extract-text", "/extract-report-text"],
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No PDF file uploaded" });
      }

      console.log(
        `Extracting text from single PDF with AI: ${req.file.originalname} (${req.file.size} bytes)`
      );

      const extracted = await extractClinicalReportWithAi({
        buffer: req.file.buffer,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
      });

      res.json({
        success: true,
        textReport: extracted.textReport || "",
        reportContent: extracted.textReport || "",
        impression: extracted.impression || "",
        modality: extracted.modality || "",
        modelUsed: extracted.modelUsed || "unknown",
        fileName: req.file.originalname,
        fileSize: req.file.size,
      });
    } catch (error) {
      console.error("Error extracting text from file:", error);
      res.status(500).json({
        error: "Failed to extract text from document",
        details: error.message,
      });
    }
  }
);

// Delete uploaded report file from Cloudflare R2
router.post("/delete-file", async (req, res) => {
  try {
    const { fileUrl } = req.body;
    if (!fileUrl) {
      return res.status(400).json({ error: "fileUrl is required" });
    }

    const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
    const publicUrl = process.env.R2_PUBLIC_URL || "";
    let key = fileUrl;
    if (publicUrl && fileUrl.startsWith(publicUrl)) {
      key = fileUrl.slice(publicUrl.length).replace(/^\/+/, "");
    } else {
      try {
        const parsed = new URL(fileUrl, "http://dummy");
        key = parsed.pathname.replace(/^\/+/, "");
      } catch {
        key = fileUrl.replace(/^https?:\/\/[^\/]+\//, "");
      }
    }

    console.log(`Deleting file from R2 bucket ${process.env.R2_BUCKET_NAME}, key: ${key}`);
    const command = new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
    });

    await s3Client.send(command);

    res.json({
      success: true,
      message: "File deleted successfully from storage",
      deletedKey: key,
    });
  } catch (error) {
    console.error("Error deleting file from R2:", error);
    res.status(500).json({
      error: "Failed to delete file",
      details: error.message,
    });
  }
});

// Helper function to get PDF page count
async function getPdfPageCount(pdfBuffer) {
  try {
    const { PDFDocument } = require("pdf-lib");
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    return pdfDoc.getPageCount();
  } catch (error) {
    console.error("Error getting PDF page count:", error);
    return 0;
  }
}

// Handle single file upload (backward compatibility)
router.post("/upload-single", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { receiptId, testId } = req.body;
    if (!receiptId || !testId) {
      return res.status(400).json({ error: "Missing receiptId or testId" });
    }

    // Generate a unique filename
    const fileExtension = req.file.originalname.split(".").pop();
    const fileName = `${
      req.hospitalId
    }/${receiptId}/${testId}/${uuidv4()}.${fileExtension}`;

    // Upload to R2
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileName,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    });

    await s3Client.send(command);

    // Generate the public URL
    const fileUrl = `${process.env.R2_PUBLIC_URL}/${fileName}`;

    res.json({
      success: true,
      fileUrl,
      message: "File uploaded successfully",
    });
  } catch (error) {
    console.error("Error uploading file:", error);
    res.status(500).json({
      error: "Failed to upload file",
      details: error.message,
    });
  }
});

// Handle consent PDF upload
router.post(
  "/upload-consent",
  upload.single("consentFile"),
  async (req, res) => {
    try {
      console.log("Consent upload request received");
      console.log("Request body:", req.body);
      console.log("Request file:", req.file ? "File present" : "No file");

      if (!req.file) {
        console.log("No file uploaded");
        return res.status(400).json({ error: "No file uploaded" });
      }

      const { patientId, consentType, consentId } = req.body;
      if (!patientId || !consentType) {
        return res
          .status(400)
          .json({ error: "Missing patientId or consentType" });
      }

      // Validate file type
      if (req.file.mimetype !== "application/pdf") {
        return res.status(400).json({ error: "Only PDF files are allowed" });
      }

      // Generate a unique filename for consent
      const fileName = `${
        req.hospitalId
      }/consents/${patientId}/${consentType}_${consentId || uuidv4()}.pdf`;

      // Upload to R2
      const command = new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: fileName,
        Body: req.file.buffer,
        ContentType: "application/pdf",
      });

      await s3Client.send(command);

      // Generate the public URL
      const fileUrl = `${process.env.R2_PUBLIC_URL}/${fileName}`;

      res.json({
        success: true,
        fileUrl,
        fileName,
        message: "Consent PDF uploaded successfully",
        consentData: {
          patientId,
          consentType,
          consentId: consentId || uuidv4(),
          fileUrl,
          fileName,
          uploadedAt: new Date().toISOString(),
          fileSize: req.file.size,
        },
      });
    } catch (error) {
      console.error("Error uploading consent file:", error);
      console.error("Error stack:", error.stack);
      res.status(500).json({
        error: "Failed to upload consent file",
        details: error.message,
      });
    }
  }
);

module.exports = router;
