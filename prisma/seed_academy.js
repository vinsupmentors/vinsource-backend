// node prisma/seed_academy.js
//
// Seeds AcademyCourse + AcademyModule rows for Vinsup Skill Academy's Student
// Academy CRM (Phase 1 of the Student-Academy extension).
//
// Module/hours/day-range data is sourced verbatim from the uploaded syllabi:
//   - Vinsup_Complete_Syllabus.docx   -> Data Analytics, UX/UI Design, Digital Marketing
//   - DataVersePro_Syllabus_Vinsup.docx -> Data Verse Pro (Phase 2 of the Gen AI
//     Data Architect program; Phase 1 of that program IS the Data Analytics
//     course above, so Data Verse Pro here only carries its own 100-hour /
//     10-module Phase 2 curriculum, not the combined 200-hour total).
//
// MERN Stack is seeded as an empty-module "custom course" shell (isCustom:
// true) per the agreed decision to build custom-course support now and let
// Production Managers add modules later, rather than blocking on more
// syllabi. Any other ad-hoc course (Frontend/Backend/AI, etc.) Production
// Managers add later through the UI works the same way.
//
// Safe to re-run (idempotent): courses are upserted by name, modules by
// courseId+order.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const COURSES = [
  {
    name: 'Data Analytics',
    description:
      'Statistics, Excel, MySQL, Python (NumPy/Pandas/Matplotlib/Seaborn), and Power BI — 100 hours, 25 days.',
    totalHours: 100,
    isCustom: false,
    modules: [
      { order: 1, title: 'Foundations of Data Analytics & Statistics', hours: 8, dayRange: 'Day 1-2' },
      { order: 2, title: 'Microsoft Excel for Data Analytics', hours: 20, dayRange: 'Day 3-7' },
      { order: 3, title: 'MySQL - Database Management & SQL', hours: 20, dayRange: 'Day 8-12' },
      { order: 4, title: 'Python for Data Analytics', hours: 28, dayRange: 'Day 13-19' },
      { order: 5, title: 'Power BI - Business Intelligence & Dashboards', hours: 20, dayRange: 'Day 20-24' },
      { order: 6, title: 'Capstone Project & Career Readiness', hours: 4, dayRange: 'Day 25' },
    ],
  },
  {
    name: 'UX UI & Graphic Design',
    description:
      'Figma, FigJam, Miro, Photoshop, Illustrator, InDesign, Blender, Behance — 100 hours, 25 days.',
    totalHours: 100,
    isCustom: false,
    modules: [
      { order: 1, title: 'Design Thinking & UX Foundations', hours: 8, dayRange: 'Day 1-2' },
      { order: 2, title: 'Miro & FigJam - Collaboration & Ideation', hours: 8, dayRange: 'Day 3-4' },
      { order: 3, title: 'Figma - UI Design & Prototyping', hours: 24, dayRange: 'Day 5-10' },
      { order: 4, title: 'Adobe Photoshop - Image Editing & Digital Design', hours: 12, dayRange: 'Day 11-13' },
      { order: 5, title: 'Adobe Illustrator - Vector Graphics', hours: 12, dayRange: 'Day 14-16' },
      { order: 6, title: 'Adobe InDesign - Layout & Print Design', hours: 8, dayRange: 'Day 17-18' },
      { order: 7, title: 'Blender - 3D Design for UI', hours: 12, dayRange: 'Day 19-21' },
      { order: 8, title: 'Behance Portfolio & Capstone Project', hours: 16, dayRange: 'Day 22-25' },
    ],
  },
  {
    name: 'Digital Marketing',
    description:
      'SEO, WordPress, Canva, SMO, SMM, Shopify, Email, Affiliate, Google Ads, Analytics & AI — 100 hours, 25 days.',
    totalHours: 100,
    isCustom: false,
    modules: [
      { order: 1, title: 'Digital Marketing Fundamentals & Inbound Marketing', hours: 4, dayRange: 'Day 1' },
      { order: 2, title: 'Search Engine Optimization (SEO)', hours: 12, dayRange: 'Day 2-4' },
      { order: 3, title: 'WordPress Website Development', hours: 16, dayRange: 'Day 5-8' },
      { order: 4, title: 'Canva & Content Marketing', hours: 8, dayRange: 'Day 9-10' },
      { order: 5, title: 'Presentation & Mini Project Review', hours: 4, dayRange: 'Day 11' },
      { order: 6, title: 'Social Media Optimization (SMO)', hours: 4, dayRange: 'Day 12' },
      { order: 7, title: 'Test 1 - SEO & WordPress', hours: 4, dayRange: 'Day 13' },
      { order: 8, title: 'Social Media Marketing (SMM) & Paid Advertising', hours: 12, dayRange: 'Day 14-16' },
      { order: 9, title: 'Shopify - E-Commerce Store', hours: 8, dayRange: 'Day 17-18' },
      { order: 10, title: 'Email Marketing', hours: 4, dayRange: 'Day 19' },
      { order: 11, title: 'Affiliate Marketing', hours: 4, dayRange: 'Day 20' },
      { order: 12, title: 'Test 2 - SMO, SMM, Shopify & Email', hours: 4, dayRange: 'Day 21' },
      { order: 13, title: 'Google AdSense & Content Monetization', hours: 4, dayRange: 'Day 22' },
      { order: 14, title: 'Search Engine Marketing (SEM) & Google Ads', hours: 12, dayRange: 'Day 22-24' },
      { order: 15, title: 'Web Analytics, Performance Tracking & AI Tools', hours: 8, dayRange: 'Day 23-24' },
      { order: 16, title: 'Capstone Project & Career Readiness', hours: 4, dayRange: 'Day 25' },
    ],
  },
  {
    name: 'Data Verse Pro',
    description:
      'Gen AI Data Architect Program, Phase 2 (Advanced Track): ML, Deep Learning, NLP, GenAI/LLMs, Big Data — 100 hours, 25 days. Prerequisite: Data Analytics (Phase 1) or equivalent.',
    totalHours: 100,
    isCustom: false,
    modules: [
      { order: 1, title: 'Advanced Python Programming & OOP', hours: 8, dayRange: 'Day 1-2' },
      { order: 2, title: 'Mathematics & Statistics for Machine Learning', hours: 12, dayRange: 'Day 3-5' },
      { order: 3, title: 'Machine Learning - Supervised Learning', hours: 16, dayRange: 'Day 6-9' },
      { order: 4, title: 'Machine Learning - Unsupervised Learning & Feature Engineering', hours: 8, dayRange: 'Day 10-11' },
      { order: 5, title: 'Deep Learning - Neural Networks (TensorFlow & Keras)', hours: 12, dayRange: 'Day 12-14' },
      { order: 6, title: 'Natural Language Processing (NLP)', hours: 8, dayRange: 'Day 15-16' },
      { order: 7, title: 'Generative AI & Large Language Models (LLMs)', hours: 16, dayRange: 'Day 17-20' },
      { order: 8, title: 'Big Data - Hadoop Ecosystem', hours: 8, dayRange: 'Day 21-22' },
      { order: 9, title: 'Big Data - Apache Spark & PySpark', hours: 8, dayRange: 'Day 23-24' },
      { order: 10, title: 'Data Architecture, Pipelines & Capstone', hours: 4, dayRange: 'Day 25' },
    ],
  },
  {
    name: 'MERN Stack',
    description: 'Custom course shell — modules to be added by the Production Manager.',
    totalHours: null,
    isCustom: true,
    modules: [],
  },
];

async function main() {
  for (const courseDef of COURSES) {
    const { modules, ...courseData } = courseDef;

    const course = await p.academyCourse.upsert({
      where: { name: courseData.name },
      update: courseData,
      create: courseData,
    });

    console.log(`Course: ${course.name} (upserted)`);

    for (const mod of modules) {
      const existingModule = await p.academyModule.findFirst({
        where: { courseId: course.id, order: mod.order },
      });
      if (existingModule) {
        await p.academyModule.update({ where: { id: existingModule.id }, data: { ...mod, courseId: course.id } });
      } else {
        await p.academyModule.create({ data: { ...mod, courseId: course.id } });
      }
    }
    console.log(`  -> ${modules.length} module(s) upserted`);
  }
}

main()
  .then(async () => {
    console.log('\nSeed complete.');
    await p.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await p.$disconnect();
    process.exit(1);
  });
