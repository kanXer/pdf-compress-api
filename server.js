import express from "express";
import multer from "multer";
import sharp from "sharp";
import { exec } from "child_process";
import { PDFDocument } from "pdf-lib";
import { promisify } from "util";
import cors from "cors";
import fs from "fs";
import path from "path";
import archiver from "archiver";

const execPromise = promisify(exec);
const app = express();
app.use(cors());
const upload = multer({ dest: "uploads/" });

// Folders Setup
const OUTPUT_DIR = "outputs";
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

// Global Cleanup Helpers
const cleanupFiles = (files) => files.forEach(f => {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {}
});

const cleanupFolder = (folderPath) => {
    try { if (fs.existsSync(folderPath)) fs.rmSync(folderPath, { recursive: true, force: true }); } catch(e) {}
};

// ==========================================
// 1. LOGIC: HIGH ACCURACY COMPRESSION
// ==========================================
async function highAccuracyCompress(inputPath, targetKB) {
    const sessionID = Math.random().toString(36).substring(7);
    const tempPrefix = `temp_comp_${sessionID}`;
    
    try {
        const gsPath = path.join(OUTPUT_DIR, `gs_${sessionID}.pdf`);
        await execPromise(`gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile=${gsPath} "${inputPath}"`);
        
        let s = fs.statSync(gsPath).size / 1024;
        if (s <= targetKB && s >= targetKB * 0.9) return gsPath;

        await execPromise(`pdftoppm -jpeg -r 150 "${inputPath}" "${tempPrefix}"`);
        const files = fs.readdirSync('.').filter(f => f.startsWith(tempPrefix)).sort();

        let minQ = 5, maxQ = 95, currentWidth = 1500, finalBuffer = null;

        for (let i = 0; i < 7; i++) {
            const q = Math.floor((minQ + maxQ) / 2);
            const pdf = await PDFDocument.create();
            const pageBuffers = await Promise.all(files.map(f => 
                sharp(f).resize({ width: currentWidth }).jpeg({ quality: q, mozjpeg: true }).toBuffer()
            ));

            for (const b of pageBuffers) {
                const img = await pdf.embedJpg(b);
                pdf.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
            }

            const bytes = await pdf.save();
            const currentSize = bytes.length / 1024;
            finalBuffer = bytes;

            if (Math.abs(currentSize - targetKB) < targetKB * 0.03) break;
            if (currentSize > targetKB) { maxQ = q - 1; if (q < 20) currentWidth = Math.floor(currentWidth * 0.85); }
            else { minQ = q + 1; }
        }

        const finalPath = path.join(OUTPUT_DIR, `acc_${sessionID}.pdf`);
        fs.writeFileSync(finalPath, finalBuffer);
        cleanupFiles(files); 
        return finalPath;
    } catch (e) { throw e; }
}

// ==========================================
// 2. LOGIC: IMAGE-BASED PDF SPLITTING (ZIP)
// ==========================================
async function splitPdfToZip(inputPath, originalName) {
    const sessionID = Math.random().toString(36).substring(7);
    const workDir = path.join(OUTPUT_DIR, `split_session_${sessionID}`);
    const toolFolder = path.join(workDir, "fastpdftool");
    const zipPath = path.join(OUTPUT_DIR, `${sessionID}_split.zip`);

    fs.mkdirSync(toolFolder, { recursive: true });

    try {
        // Step 1: PDF to Images (Rasterize at 200 DPI for clarity)
        const imgPrefix = path.join(workDir, "page");
        await execPromise(`pdftoppm -jpeg -r 200 "${inputPath}" "${imgPrefix}"`);

        const imageFiles = fs.readdirSync(workDir)
            .filter(f => f.startsWith("page-") && f.endsWith(".jpg"))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

        const baseFileName = path.parse(originalName).name;

        // Step 2: Convert each image to individual PDF
        await Promise.all(imageFiles.map(async (imgFile, index) => {
            const pdfDoc = await PDFDocument.create();
            const imgBytes = fs.readFileSync(path.join(workDir, imgFile));
            const image = await pdfDoc.embedJpg(imgBytes);
            const page = pdfDoc.addPage([image.width, image.height]);
            page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
            
            const pdfBytes = await pdfDoc.save();
            fs.writeFileSync(path.join(toolFolder, `${baseFileName}_page-${index + 1}.pdf`), pdfBytes);
        }));

        // Step 3: Zip it up
        return new Promise((resolve, reject) => {
            const output = fs.createWriteStream(zipPath);
            const archive = archiver('zip', { zlib: { level: 6 } });

            output.on('close', () => resolve({ zipPath, workDir }));
            archive.on('error', (err) => reject(err));

            archive.pipe(output);
            archive.directory(toolFolder, false);
            archive.finalize();
        });
    } catch (e) {
        cleanupFolder(workDir);
        throw e;
    }
}

// ==========================================
// ENDPOINTS
// ==========================================

app.post("/compress-pdf", upload.single("file"), async (req, res) => {
    try {
        const target = parseInt(req.body.target);
        const resultPath = await highAccuracyCompress(req.file.path, target);
        res.download(resultPath, () => cleanupFiles([req.file.path, resultPath]));
    } catch (e) { res.status(500).send("Compression Error: " + e.message); }
});

app.post("/split-pdf", upload.single("file"), async (req, res) => {
    try {
        const { zipPath, workDir } = await splitPdfToZip(req.file.path, req.file.originalname);
        res.download(zipPath, "fastpdftool_split.zip", () => {
            cleanupFolder(workDir);
            cleanupFiles([req.file.path, zipPath]);
        });
    } catch (e) { res.status(500).send("Split Error: " + e.message); }
});

app.listen(3000, () => console.log("Turbo Engine Live on Port 3000..."));
