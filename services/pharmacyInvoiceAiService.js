const mongoose = require("mongoose");
const { GoogleGenAI } = require("@google/genai");
const axios = require("axios");
const dayjs = require("dayjs");
const MasterMedicine = require("../models/MasterMedicine");
const Vendor = require("../models/Vendor");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_VISION_MODEL || "gemini-3.1-flash-lite";

const INVOICE_PARSER_PROMPT = `You are a medical pharmacy auditor for an Indian clinic/hospital.
Extract all distributor/vendor details, bill metadata, and EVERY medicine line item from this pharmaceutical purchase invoice into strict valid JSON.

JSON SCHEMA:
{
  "vendor": {
    "name": "Distributor/supplier firm name",
    "gst": "GSTIN number or null",
    "mobile": "Contact phone/mobile or null",
    "address": "Full address or null",
    "dlNo": "Drug license number or null"
  },
  "invoice": {
    "invoiceNo": "Invoice/Bill number",
    "invoiceDate": "YYYY-MM-DD",
    "dueDate": "YYYY-MM-DD or null",
    "invoiceValue": 0.00
  },
  "items": [
    {
      "itemDesc": "Brand name, form and strength (e.g. Dolo 650 Tab, Pantop 40mg, Augmentin 625, Telma 40)",
      "hsnCode": "HSN code or null",
      "batchNo": "Batch number",
      "expiryDate": "YYYY-MM-DD (calculate last day of month if given MM/YY or MM/YYYY)",
      "manufactureDate": "YYYY-MM-DD or null",
      "quantity": 10,
      "freeQuantity": 0,
      "packSize": 10,
      "purcRate": 100.00,
      "mrp": 130.00,
      "gstPercent": 12,
      "discount": 0
    }
  ]
}

CRITICAL RULES:
1. Extract ALL medicines present on the invoice. Do NOT truncate or skip rows.
2. If pack size is not explicitly mentioned, assume 10 for tablets/capsules, and 1 for liquids/syrups/injections/ointments.
3. purcRate must be the purchase cost per strip/pack (before GST).
4. mrp must be the Maximum Retail Price printed on the pack.
5. All dates must be in YYYY-MM-DD format.
6. Return valid JSON only with NO markdown fences, headers, or explanations.`;

/**
 * Parses purchase invoice image or PDF using Gemini Vision
 */
async function parseInvoiceWithGemini({ buffer, mimeType }) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const client = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const base64Data = buffer.toString("base64");

  const contents = [
    {
      role: "user",
      parts: [
        {
          inlineData: {
            mimeType: mimeType || "image/jpeg",
            data: base64Data,
          },
        },
        {
          text: INVOICE_PARSER_PROMPT,
        },
      ],
    },
  ];

  const response = await client.models.generateContent({
    model: GEMINI_MODEL,
    contents,
    config: {
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });

  const responseText = response.text?.trim();
  if (!responseText) {
    throw new Error("Empty response from AI invoice scanner.");
  }

  // Clean any markdown formatting if present
  const cleanJsonStr = responseText.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  return JSON.parse(cleanJsonStr);
}

/**
 * Fallback to OpenAI Vision (GPT-4o) if Gemini encounters rate limits or errors
 */
async function parseInvoiceWithOpenAI({ buffer, mimeType }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not configured.");
  }

  const base64Data = buffer.toString("base64");
  const dataUrl = `data:${mimeType || "image/jpeg"};base64,${base64Data}`;

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      messages: [
        { role: "system", content: INVOICE_PARSER_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "Parse this purchase invoice into the requested JSON schema." },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 45000,
    }
  );

  const rawContent = response.data?.choices?.[0]?.message?.content;
  return JSON.parse(rawContent);
}

/**
 * Normalize and match parsed invoice data against master catalog and vendors.
 */
async function processParsedInvoice(parsedData, hospitalId) {
  const vendorInfo = parsedData.vendor || {};
  const invoiceInfo = parsedData.invoice || {};
  const items = Array.isArray(parsedData.items) ? parsedData.items : [];

  // 1. Try to find or match Vendor
  let matchedVendor = null;
  if (
    vendorInfo.name &&
    hospitalId &&
    mongoose.Types.ObjectId.isValid(hospitalId) &&
    mongoose.connection?.readyState === 1
  ) {
    const cleanVendorName = vendorInfo.name.trim();
    try {
      matchedVendor = await Vendor.findOne({
        hospitalId: new mongoose.Types.ObjectId(hospitalId),
        name: new RegExp(`^${cleanVendorName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"),
      }).lean();
    } catch (_err) {
      matchedVendor = null;
    }
  }

  const invoiceDate = invoiceInfo.invoiceDate
    ? dayjs(invoiceInfo.invoiceDate).isValid()
      ? dayjs(invoiceInfo.invoiceDate).format("YYYY-MM-DD")
      : dayjs().format("YYYY-MM-DD")
    : dayjs().format("YYYY-MM-DD");

  const dueDate = invoiceInfo.dueDate && dayjs(invoiceInfo.dueDate).isValid()
    ? dayjs(invoiceInfo.dueDate).format("YYYY-MM-DD")
    : dayjs(invoiceDate).add(30, "day").format("YYYY-MM-DD");

  const invoiceData = {
    vendorId: matchedVendor?._id?.toString() || "",
    vendorName: matchedVendor?.name || vendorInfo.name || "Unknown Distributor",
    mobile: matchedVendor?.phone || vendorInfo.mobile || "",
    GST: matchedVendor?.gstin || vendorInfo.gst || "",
    address: matchedVendor?.address || vendorInfo.address || "",
    DLNo: vendorInfo.dlNo || "",
    invoiceNo: invoiceInfo.invoiceNo || `INV-${Date.now()}`,
    invoiceDate,
    dueDate,
    invoiceValue: Number(invoiceInfo.invoiceValue) || 0,
    receiptType: "Credit",
    paymentMethod: "Credit",
    purcTax: "ex",
    status: "Received",
    handlingCharges: "0",
    discount: "0",
    tcs: "0",
    roundOff: "0",
  };

  // 2. Process Line Items and match against MasterMedicine
  const processedItems = [];

  for (const item of items) {
    const rawDesc = String(item.itemDesc || "Medicine Item").trim();
    const qtyApproved = Math.max(1, Number(item.quantity) || 1);
    const freeItems = Math.max(0, Number(item.freeQuantity) || 0);
    const packSize = Math.max(1, Number(item.packSize) || 10);
    const totalQty = (qtyApproved + freeItems) * packSize;

    const purcRate = Math.max(0, Number(item.purcRate) || 0);
    const saleRate = Math.max(purcRate, Number(item.mrp) || Math.round(purcRate * 1.25));

    const unitRate = packSize > 0 ? purcRate / packSize : purcRate;
    const unitMRP = packSize > 0 ? saleRate / packSize : saleRate;

    const gstVal = Number(item.gstPercent) || 12;
    const purcTax = `${gstVal}%`;
    const purcAmt = Math.round(qtyApproved * purcRate * 100) / 100;
    const saleAmt = Math.round((qtyApproved + freeItems) * saleRate * 100) / 100;

    const discountPercent = Number(item.discount) || 0;
    const discountAmount = Math.round(purcAmt * (discountPercent / 100) * 100) / 100;
    const afterDiscountAmount = purcAmt - discountAmount;

    const cgst = gstVal / 2;
    const sgst = gstVal / 2;
    const igst = 0;
    const purcTaxAmt = Math.round(afterDiscountAmount * (gstVal / 100) * 100) / 100;
    const cgstAmount = Math.round((purcTaxAmt / 2) * 100) / 100;
    const sgstAmount = Math.round((purcTaxAmt / 2) * 100) / 100;

    const unitPurcValue = totalQty > 0 ? (afterDiscountAmount + purcTaxAmt) / totalQty : 0;
    const margin = saleAmt > purcAmt ? Math.round(((saleAmt - purcAmt) / saleAmt) * 100) : 20;
    const marginAmount = Math.max(0, saleAmt - purcAmt);

    // Normalize expiry date (e.g. ensure valid date or fallback 2 years out)
    let expiryDate = item.expiryDate;
    if (!expiryDate || !dayjs(expiryDate).isValid()) {
      expiryDate = dayjs().add(2, "year").endOf("month").format("YYYY-MM-DD");
    } else {
      expiryDate = dayjs(expiryDate).format("YYYY-MM-DD");
    }

    // Try finding in MasterMedicine
    let matchedMaster = null;
    if (mongoose.connection?.readyState === 1) {
      try {
        matchedMaster = await MasterMedicine.findOne({
          description: new RegExp(`^${rawDesc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"),
        }).select("item_code description hsn_code pack").lean();

        if (!matchedMaster) {
          // First 2 words match
          const words = rawDesc.split(/\s+/).slice(0, 2).join(" ");
          if (words.length >= 3) {
            matchedMaster = await MasterMedicine.findOne({
              description: new RegExp(words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
            }).select("item_code description hsn_code pack").lean();
          }
        }
      } catch (_err) {
        matchedMaster = null;
      }
    }

    const itemId = matchedMaster?.item_code || `MED_${rawDesc.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase().slice(0, 24)}`;
    const hsnCode = item.hsnCode || matchedMaster?.hsn_code || "300490";

    processedItems.push({
      itemId,
      itemDesc: matchedMaster?.description || rawDesc,
      hsnCode,
      batchNo: item.batchNo || `BAT-${Date.now().toString().slice(-4)}`,
      expiryDate,
      manufactureDate: item.manufactureDate || null,
      quantityApproved: qtyApproved,
      packSize,
      totalQty,
      saleRate,
      purcRate,
      unitRate,
      unitMRP,
      purcTax,
      purcTaxValue: gstVal,
      discount: discountPercent,
      purchaseUnitRate: unitRate,
      cgst,
      sgst,
      igst,
      purcTaxAmt,
      margin,
      unitPurcValue,
      purcAmt,
      saleAmt,
      marginAmount,
      discountAmount,
      afterDiscountAmount,
      cgstAmount,
      sgstAmount,
      igstAmount: 0,
      freeItems,
      isMasterMatched: Boolean(matchedMaster),
    });
  }

  // Calculate grand cart total
  const calculatedCartTotal = processedItems.reduce((acc, it) => acc + (it.purcAmt + it.purcTaxAmt), 0);
  if (!invoiceData.invoiceValue || invoiceData.invoiceValue === 0) {
    invoiceData.invoiceValue = Math.round(calculatedCartTotal);
  }

  return {
    invoiceData,
    items: processedItems,
    calculatedTotal: Math.round(calculatedCartTotal * 100) / 100,
    itemsCount: processedItems.length,
  };
}

/**
 * Main entry point: Parse invoice image/PDF and return ready-to-use cart & invoice data.
 */
async function scanPharmacyInvoice({ buffer, mimeType, hospitalId }) {
  let parsedRaw = null;

  try {
    parsedRaw = await parseInvoiceWithGemini({ buffer, mimeType });
  } catch (geminiErr) {
    console.warn("Gemini Vision failed for invoice scan, trying OpenAI fallback:", geminiErr.message);
    try {
      parsedRaw = await parseInvoiceWithOpenAI({ buffer, mimeType });
    } catch (openAiErr) {
      console.error("Both Gemini and OpenAI Vision invoice extraction failed:", openAiErr);
      throw new Error(`AI invoice scanning failed: ${geminiErr.message}`);
    }
  }

  if (!parsedRaw || (!parsedRaw.items && !parsedRaw.invoice)) {
    throw new Error("Could not extract medicine items from invoice. Ensure the bill is clear and legible.");
  }

  return processParsedInvoice(parsedRaw, hospitalId);
}

module.exports = {
  scanPharmacyInvoice,
  processParsedInvoice,
};
