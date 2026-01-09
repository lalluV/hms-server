const express = require("express");
const multer = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { v4: uuidv4 } = require("uuid");
const dotenv = require("dotenv");
const FileMerger = require("../utils/fileMerger");

dotenv.config();

const router = express.Router();
const flexibleAuth = require("../middleware/flexibleAuth");

// Use flexible auth that accepts both admin and user tokens
router.use(flexibleAuth);

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
router.post("/upload-report", upload.array("files", 10), async (req, res) => {
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
    const fileName = `${
      req.hospitalId
    }/${receiptId}/${testId}/merged_${uuidv4()}.pdf`;

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

    res.json({
      success: true,
      fileUrl,
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
