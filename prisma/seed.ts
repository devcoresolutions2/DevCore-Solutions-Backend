import "dotenv/config";
import { prisma } from "../src/server/db/prisma";

async function main() {
    await prisma.contactSettings.upsert({
        where: { id: "singleton" },
        update: {},
        create: {
            id: "singleton",
            whatsappNumber: "+8801766140126",
            phone: "+8801766140126",
            publicEmail: "dev.core.solution2@gmail.com",
            notifyEmails: ["dev.core.solution2@gmail.com", "pinonfurkan1@gmail.com", "kazisamin0173@gmail.com"],
            address: "North Agrabad, Chattogram, Bangladesh",
            timezone: "Asia/Dhaka",
            businessHours: {
                sunday: { open: "09:00", close: "18:00", closed: false },
                monday: { open: "09:00", close: "18:00", closed: false },
                tuesday: { open: "09:00", close: "18:00", closed: false },
                wednesday: { open: "09:00", close: "18:00", closed: false },
                thursday: { open: "09:00", close: "18:00", closed: false },
                friday: { open: "09:00", close: "18:00", closed: true },
                saturday: { open: "10:00", close: "16:00", closed: false },
            },
            whatsappMessage: "Hello DevCore, I would like to discuss a project.",
            callbackPromise: "We call back within 1 business hour",
            socialLinks: {
                facebook: "https://www.facebook.com/devcoresolutionsofficial",
                instagram: "https://www.instagram.com/devcoresolutionsofficial/",
                twitter: "https://x.com/DevCoreSolution",
                linkedin: "https://www.linkedin.com/company/devcoresolutions2",
                youtube: "https://www.youtube.com/@DevCoreSolutionsOfficial",
                reddit: "https://www.reddit.com/user/DevCoreSolutions2/",
            },
        },
    });

    console.log("DevCore ContactSettings seeded successfully.");
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });