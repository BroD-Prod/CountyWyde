const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");

const region = String(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-2").trim();
const sesClient = new SESv2Client({ region });

function buildTextBody({ code, ttlMinutes }) {
    return [
        "Your CountyWyde verification code",
        "",
        `Code: ${code}`,
        "",
        `This code expires in ${ttlMinutes} minutes.`,
        "If you did not try to sign in, you can ignore this email.",
    ].join("\n");
}

async function sendTwoFactorEmail({ toEmail, code, ttlMinutes = 10 }) {
    const fromEmail = String(process.env.SES_FROM_EMAIL || "").trim();
    if (!fromEmail) {
        throw new Error("SES_FROM_EMAIL is not configured");
    }

    const replyTo = String(process.env.SES_REPLY_TO_EMAIL || "").trim();
    const params = {
        FromEmailAddress: fromEmail,
        Destination: {
            ToAddresses: [toEmail],
        },
        Content: {
            Simple: {
                Subject: {
                    Data: "Your CountyWyde verification code",
                    Charset: "UTF-8",
                },
                Body: {
                    Text: {
                        Data: buildTextBody({ code, ttlMinutes }),
                        Charset: "UTF-8",
                    },
                },
            },
        },
    };

    if (replyTo) {
        params.ReplyToAddresses = [replyTo];
    }

    await sesClient.send(new SendEmailCommand(params));
}

module.exports = {
    sendTwoFactorEmail,
};
