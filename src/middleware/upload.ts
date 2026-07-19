import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { Request } from 'express';
import { isCloudStorageEnabled } from '../services/storage.service';
import { AppError } from './errorHandler';

const UPLOADS_DIR = path.join(process.cwd(), 'uploads', 'documents');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const diskDocStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9]/gi, '_').toLowerCase();
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});

const fileFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx', '.xls', '.xlsx', '.csv'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) cb(null, true);
  else cb(new AppError('Only PDF, images, Word, and Excel documents are allowed', 400));
};

// Use memoryStorage when R2 is configured (buffer needed for cloud upload),
// otherwise fall back to diskStorage (local VPS uploads/ directory).
export const uploadDocument = multer({
  storage: isCloudStorageEnabled() ? multer.memoryStorage() : diskDocStorage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
}).single('file');

// ── Finance (Admin) expense attachments: bill copy + payment proof ──────────
const EXPENSE_UPLOADS_DIR = path.join(process.cwd(), 'uploads', 'expenses');
if (!fs.existsSync(EXPENSE_UPLOADS_DIR)) fs.mkdirSync(EXPENSE_UPLOADS_DIR, { recursive: true });

const expenseStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, EXPENSE_UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9]/gi, '_').toLowerCase();
    cb(null, `${Date.now()}_${file.fieldname}_${base}${ext}`);
  },
});

export const uploadExpenseAttachments = multer({
  storage: expenseStorage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
}).fields([
  { name: 'billCopy', maxCount: 1 },
  { name: 'paymentProof', maxCount: 1 },
]);

// ── Digital Marketing: recharge bill copies, daily-report dashboards, closure attachments ──
const CAMPAIGN_UPLOADS_DIR = path.join(process.cwd(), 'uploads', 'campaigns');
if (!fs.existsSync(CAMPAIGN_UPLOADS_DIR)) fs.mkdirSync(CAMPAIGN_UPLOADS_DIR, { recursive: true });

const campaignStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, CAMPAIGN_UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9]/gi, '_').toLowerCase();
    cb(null, `${Date.now()}_${file.fieldname}_${base}${ext}`);
  },
});

/** Bill copy for a recharge (initial campaign funding or a later top-up). */
export const uploadCampaignBill = multer({
  storage: campaignStorage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
}).single('billCopy');

// ── Profile photos (employee DP) ─────────────────────────────────────────────
const PHOTO_UPLOADS_DIR = path.join(process.cwd(), 'uploads', 'photos');
if (!fs.existsSync(PHOTO_UPLOADS_DIR)) fs.mkdirSync(PHOTO_UPLOADS_DIR, { recursive: true });

const photoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, PHOTO_UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});

const photoFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) cb(null, true);
  else cb(new AppError('Only JPG, PNG, or WebP images are allowed', 400));
};

export const uploadProfilePhoto = multer({
  storage: photoStorage,
  fileFilter: photoFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
}).single('photo');

// ── Course study materials (PDFs, slides, docs, images, archives) ────────────
const MATERIAL_UPLOADS_DIR = path.join(process.cwd(), 'uploads', 'materials');
if (!fs.existsSync(MATERIAL_UPLOADS_DIR)) fs.mkdirSync(MATERIAL_UPLOADS_DIR, { recursive: true });

const materialStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, MATERIAL_UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 60);
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});

const materialFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowed = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.csv', '.txt', '.md', '.jpg', '.jpeg', '.png', '.webp', '.zip'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) cb(null, true);
  else cb(new AppError('Allowed: PDF, Word, PowerPoint, Excel, text, images, or ZIP', 400));
};

export const uploadCourseMaterial = multer({
  storage: materialStorage,
  fileFilter: materialFilter,
  limits: { fileSize: 40 * 1024 * 1024 }, // 40 MB
}).single('file');

/** Optional ad-platform dashboard screenshot attached to a daily report. */
export const uploadCampaignDashboard = multer({
  storage: campaignStorage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
}).single('dashboardScreenshot');

/** Closure checkpoint: overall expense sheet + ad-platform dashboard export. */
export const uploadCampaignClosure = multer({
  storage: campaignStorage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
}).fields([
  { name: 'expenseSheet', maxCount: 1 },
  { name: 'dashboardScreenshot', maxCount: 1 },
]);

// ── Student portal: profile photo (used on certificates — images only) ──────
const STUDENT_PHOTO_DIR = path.join(process.cwd(), 'uploads', 'student-photos');
if (!fs.existsSync(STUDENT_PHOTO_DIR)) fs.mkdirSync(STUDENT_PHOTO_DIR, { recursive: true });

const studentPhotoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, STUDENT_PHOTO_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const studentId = (req as Request & { user?: { studentId?: string } }).user?.studentId || 'unknown';
    cb(null, `${studentId}_${Date.now()}${ext}`);
  },
});

const imageOnlyFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) cb(null, true);
  else cb(new AppError(`Only JPG, PNG, or WEBP images are allowed (got "${ext || 'unknown'}"). If this was taken on an iPhone, switch Camera settings to "Most Compatible" so photos save as .jpg instead of .heic.`, 400));
};

export const uploadStudentPhoto = multer({
  storage: studentPhotoStorage,
  fileFilter: imageOnlyFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
}).single('photo');

// ── Student portal: Aadhar card photo (KYC document — images only) ──────────
const AADHAR_PHOTO_DIR = path.join(process.cwd(), 'uploads', 'student-aadhar');
if (!fs.existsSync(AADHAR_PHOTO_DIR)) fs.mkdirSync(AADHAR_PHOTO_DIR, { recursive: true });

const aadharPhotoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AADHAR_PHOTO_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const studentId = (req as Request & { user?: { studentId?: string } }).user?.studentId || 'unknown';
    cb(null, `${studentId}_${Date.now()}${ext}`);
  },
});

export const uploadAadharPhoto = multer({
  storage: aadharPhotoStorage,
  fileFilter: imageOnlyFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
}).single('aadharPhoto');

// ── Production: Project brief resource (PDF, uploaded by Production Manager) ─
const PROJECT_RESOURCE_DIR = path.join(process.cwd(), 'uploads', 'project-resources');
if (!fs.existsSync(PROJECT_RESOURCE_DIR)) fs.mkdirSync(PROJECT_RESOURCE_DIR, { recursive: true });

const projectResourceStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, PROJECT_RESOURCE_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9]/gi, '_').toLowerCase();
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});

const pdfOnlyFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === '.pdf') cb(null, true);
  else cb(new AppError('Only PDF files are allowed for the project brief', 400));
};

export const uploadProjectResource = multer({
  storage: projectResourceStorage,
  fileFilter: pdfOnlyFilter,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
}).single('resource');

// ── Student portal: Project submission (work uploaded by a student) ─────────
const PROJECT_SUBMISSION_DIR = path.join(process.cwd(), 'uploads', 'project-submissions');
if (!fs.existsSync(PROJECT_SUBMISSION_DIR)) fs.mkdirSync(PROJECT_SUBMISSION_DIR, { recursive: true });

const projectSubmissionStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, PROJECT_SUBMISSION_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const studentId = (req as Request & { user?: { studentId?: string } }).user?.studentId || 'unknown';
    cb(null, `${studentId}_${Date.now()}_${base}${ext}`);
  },
});

export const uploadProjectSubmission = multer({
  storage: projectSubmissionStorage,
  fileFilter,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
}).single('file');

// ── Placements: offer letter attached to a PlacementResult once SELECTED ────
const OFFER_LETTER_DIR = path.join(process.cwd(), 'uploads', 'offer-letters');
if (!fs.existsSync(OFFER_LETTER_DIR)) fs.mkdirSync(OFFER_LETTER_DIR, { recursive: true });

const offerLetterStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, OFFER_LETTER_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9]/gi, '_').toLowerCase();
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});

export const uploadOfferLetter = multer({
  storage: offerLetterStorage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
}).single('offerLetter');
