const express = require("express");
const multer = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { v4: uuidv4 } = require("uuid");
const dotenv = require("dotenv");

dotenv.config();

const router = express.Router();

// Configure multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

// Configure S3 client for Cloudflare R2
const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// Handle file upload
router.post("/upload-report", upload.single("file"), async (req, res) => {
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
    const fileName = `${receiptId}/${testId}/${uuidv4()}.${fileExtension}`;

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

module.exports = router;
