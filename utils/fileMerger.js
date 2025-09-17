const { PDFDocument } = require("pdf-lib");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

class FileMerger {
  constructor() {
    this.supportedImageFormats = [
      ".jpg",
      ".jpeg",
      ".png",
      ".bmp",
      ".tiff",
      ".tif",
      ".webp",
    ];
    this.supportedPdfFormats = [".pdf"];
  }

  /**
   * Check if file is a supported image format
   */
  isImageFile(filename) {
    const ext = path.extname(filename).toLowerCase();
    return this.supportedImageFormats.includes(ext);
  }

  /**
   * Check if file is a supported PDF format
   */
  isPdfFile(filename) {
    const ext = path.extname(filename).toLowerCase();
    return this.supportedPdfFormats.includes(ext);
  }

  /**
   * Convert image to PDF page
   */
  async imageToPdfPage(imageBuffer, imageFormat = "jpeg") {
    try {
      // Process image with sharp
      const processedImage = await sharp(imageBuffer)
        .resize(800, 600, { fit: "inside", withoutEnlargement: true })
        .toFormat(imageFormat)
        .toBuffer();

      // Create a new PDF document for the image
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([800, 600]);

      // Embed the image
      let image;
      if (imageFormat === "jpeg" || imageFormat === "jpg") {
        image = await pdfDoc.embedJpg(processedImage);
      } else {
        image = await pdfDoc.embedPng(processedImage);
      }

      // Calculate dimensions to fit the page
      const { width, height } = image.scale(1);
      const pageWidth = page.getWidth();
      const pageHeight = page.getHeight();

      // Scale image to fit page while maintaining aspect ratio
      const scaleX = pageWidth / width;
      const scaleY = pageHeight / height;
      const scale = Math.min(scaleX, scaleY);

      const scaledWidth = width * scale;
      const scaledHeight = height * scale;

      // Center the image on the page
      const x = (pageWidth - scaledWidth) / 2;
      const y = (pageHeight - scaledHeight) / 2;

      page.drawImage(image, {
        x,
        y,
        width: scaledWidth,
        height: scaledHeight,
      });

      return await pdfDoc.save();
    } catch (error) {
      console.error("Error converting image to PDF:", error);
      throw new Error(`Failed to convert image to PDF: ${error.message}`);
    }
  }

  /**
   * Merge multiple files into a single PDF
   */
  async mergeFilesToPdf(files) {
    try {
      // Create a new PDF document
      const mergedPdf = await PDFDocument.create();

      // Process each file
      for (const file of files) {
        if (this.isPdfFile(file.originalname)) {
          // Handle PDF files
          await this.addPdfToDocument(mergedPdf, file.buffer);
        } else if (this.isImageFile(file.originalname)) {
          // Handle image files
          await this.addImageToDocument(
            mergedPdf,
            file.buffer,
            file.originalname
          );
        } else {
          console.warn(`Unsupported file format: ${file.originalname}`);
        }
      }

      // Return the merged PDF as buffer
      return await mergedPdf.save();
    } catch (error) {
      console.error("Error merging files:", error);
      throw new Error(`Failed to merge files: ${error.message}`);
    }
  }

  /**
   * Add PDF pages to the merged document
   */
  async addPdfToDocument(mergedPdf, pdfBuffer) {
    try {
      // Load the PDF
      const pdfDoc = await PDFDocument.load(pdfBuffer);

      // Get all pages from the PDF
      const pages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());

      // Add each page to the merged document
      pages.forEach((page) => {
        mergedPdf.addPage(page);
      });
    } catch (error) {
      console.error("Error adding PDF to document:", error);
      throw new Error(`Failed to add PDF: ${error.message}`);
    }
  }

  /**
   * Add image to the merged document
   */
  async addImageToDocument(mergedPdf, imageBuffer, filename) {
    try {
      // Convert image to PDF page
      const imagePdfBuffer = await this.imageToPdfPage(imageBuffer);

      // Load the image PDF
      const imagePdf = await PDFDocument.load(imagePdfBuffer);

      // Get the page from the image PDF
      const [page] = await mergedPdf.copyPages(imagePdf, [0]);

      // Add the page to the merged document
      mergedPdf.addPage(page);
    } catch (error) {
      console.error("Error adding image to document:", error);
      throw new Error(`Failed to add image: ${error.message}`);
    }
  }

  /**
   * Validate files before merging
   */
  validateFiles(files) {
    if (!files || files.length === 0) {
      throw new Error("No files provided for merging");
    }

    const validFiles = files.filter(
      (file) =>
        this.isPdfFile(file.originalname) || this.isImageFile(file.originalname)
    );

    if (validFiles.length === 0) {
      throw new Error(
        "No valid files found. Supported formats: PDF, JPG, PNG, BMP, TIFF, WEBP"
      );
    }

    return validFiles;
  }

  /**
   * Get file information for logging
   */
  getFileInfo(files) {
    return files.map((file) => ({
      name: file.originalname,
      size: file.size,
      type: this.isPdfFile(file.originalname) ? "PDF" : "Image",
      mimetype: file.mimetype,
    }));
  }
}

module.exports = FileMerger;
