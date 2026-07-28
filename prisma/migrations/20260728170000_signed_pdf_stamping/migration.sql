-- Store a single self-contained "signed copy" PDF (signature + selfie photo
-- stamped onto the bottom of the last page) alongside the raw signature/photo
-- images, so admins reviewing onboarding can view the document itself
-- instead of separate thumbnails.

ALTER TABLE `StudentDocumentSignature` ADD COLUMN `signedPdfUrl` VARCHAR(191) NULL;
ALTER TABLE `StudentFeeDeclaration` ADD COLUMN `signedPdfUrl` VARCHAR(191) NULL;
