import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { sendJobSummaryEmail } from "./email-service.mjs";

// Initialize AWS clients with long-term credentials
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.KEY_ID,
    secretAccessKey: process.env.ACCESS_KEY,
  },
});

const dynamoClient = new DynamoDBClient({
  region: process.env.AWS_REGION,
});

const docClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: {
    convertEmptyValues: false,
    removeUndefinedValues: true,
    convertClassInstanceToMap: false,
  },
  unmarshallOptions: {
    wrapNumbers: false,
  },
});

// Environment variables
const TABLE_NAME = process.env.TABLE_NAME;
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
const PRESIGNED_URL_EXPIRATION_DAYS = parseInt(
  process.env.PRESIGNED_URL_EXPIRATION_DAYS || "7"
);

// Constants
const EXPIRATION_SECONDS = PRESIGNED_URL_EXPIRATION_DAYS * 24 * 60 * 60;
const BATCH_SIZE = 25;

/**
 * Generate presigned URL for S3 object using long-term credentials
 * @param {string} objectKey - S3 object key
 * @returns {Promise<string>} - Presigned URL
 */
async function generatePresignedUrl(objectKey) {
  if (!objectKey) {
    throw new Error("Object key is required");
  }

  const command = new GetObjectCommand({
    Bucket: S3_BUCKET_NAME,
    Key: objectKey,
  });

  try {
    const presignedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: EXPIRATION_SECONDS,
    });
    return presignedUrl;
  } catch (error) {
    console.error(`Error generating presigned URL for ${objectKey}:`, error);
    throw error;
  }
}

// Rest of your code remains the same...
function determinePrimaryKey(item) {
  // Prefer composite key if both are present
  if (item.imageName && item.selectionId) {
    return { imageName: item.imageName, selectionId: item.selectionId };
  }
  // Fallback to just imageName
  if (item.imageName) {
    return { imageName: item.imageName };
  }
  // Fallback to just selectionId
  if (item.selectionId) {
    return { selectionId: item.selectionId };
  }
  if (item.id) {
    return { id: item.id };
  }
  console.error("No valid key found for item:", JSON.stringify(item, null, 2));
  return null;
}

async function updateItemPresignedUrls(item) {
  try {
    const updates = {};
    const updateExpressions = [];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};

    // For SelectionItem, use objectKey for S3 and update presignedUrl
    if (item.objectKey) {
      try {
        const presignedUrl = await generatePresignedUrl(item.objectKey);
        updates.presignedUrl = presignedUrl;
        updateExpressions.push("#purl = :purl");
        expressionAttributeNames["#purl"] = "presignedUrl";
        expressionAttributeValues[":purl"] = presignedUrl;
      } catch (error) {
        console.warn(
          `Failed to generate presigned URL for objectKey ${item.objectKey}:`, error.message
        );
      }
    }

    // Always update presignedUrlTimestamp
    const currentDateTime = new Date().toISOString();
    updateExpressions.push("#ptimestamp = :ptimestamp");
    expressionAttributeNames["#ptimestamp"] = "presignedUrlTimestamp";
    expressionAttributeValues[":ptimestamp"] = currentDateTime;

    if (updateExpressions.length === 1) {
      // Only timestamp, no presignedUrl
      console.warn(
        `No presignedUrl generated for item ${item.imageName || "unknown"}`
      );
      return { success: false, error: "No presignedUrl generated" };
    }

    const key = determinePrimaryKey(item);
    if (!key) {
      console.error(
        "Unable to determine primary key for item:",
        JSON.stringify(item, null, 2)
      );
      return { success: false, error: "Unable to determine primary key" };
    }

    const updateCommand = new UpdateCommand({
      TableName: TABLE_NAME,
      Key: key,
      UpdateExpression: `SET ${updateExpressions.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: "UPDATED_NEW",
    });

    console.log(
      `Attempting to update item with key:`,
      JSON.stringify(key, null, 2)
    );
    console.log(`Update expression:`, updateCommand.UpdateExpression);

    const result = await docClient.send(updateCommand);
    console.log(
      `Successfully updated presignedUrl for item: ${item.imageName || "unknown"}`
    );
    return { success: true };
  } catch (error) {
    console.error(`Error updating item ${item.imageName || "unknown"}:`, error);
    console.error(`Item details:`, JSON.stringify(item, null, 2));
    return { success: false, error: error.message };
  }
}

async function processItemsBatch(items) {
  const promises = items.map((item) => updateItemPresignedUrls(item));

  try {
    const results = await Promise.allSettled(promises);

    let successCount = 0;
    let errorCount = 0;

    results.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value.success) {
        successCount++;
      } else {
        errorCount++;
        if (result.status === "rejected") {
          console.error(`Failed to process item ${index}:`, result.reason);
        } else if (result.value.error) {
          console.error(`Failed to process item ${index}:`, result.value.error);
        }
      }
    });

    return { successCount, errorCount };
  } catch (error) {
    console.error("Error processing batch:", error);
    return { successCount: 0, errorCount: items.length };
  }
}

export const regeneratePresignedUrls = async (event, context) => {
  console.log("Starting presigned URL regeneration process");
  console.log("Event:", JSON.stringify(event, null, 2));

  const startTime = Date.now();
  let processedCount = 0;
  let errorCount = 0;
  let successCount = 0;
  let jobStatus = "success";
  let jobError = null;

  try {
    if (!TABLE_NAME || !S3_BUCKET_NAME) {
      throw new Error(
        "Required environment variables TABLE_NAME and S3_BUCKET_NAME must be set"
      );
    }

    // Validate that long-term credentials are available
    if (!process.env.KEY_ID || !process.env.ACCESS_KEY) {
      throw new Error(
        "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set for long-term presigned URLs"
      );
    }

    console.log(
      `Configuration: TABLE_NAME=${TABLE_NAME}, S3_BUCKET_NAME=${S3_BUCKET_NAME}, EXPIRATION_DAYS=${PRESIGNED_URL_EXPIRATION_DAYS}`
    );
    console.log(
      `Table schema: imageName is the partition key (single primary key)`
    );

    let lastEvaluatedKey = null;
    let hasMoreItems = true;

    while (hasMoreItems) {
      const scanParams = {
        TableName: TABLE_NAME,
        Limit: BATCH_SIZE,
      };

      if (lastEvaluatedKey) {
        scanParams.ExclusiveStartKey = lastEvaluatedKey;
      }

      console.log(`Scanning table ${TABLE_NAME} with params:`, scanParams);

      try {
        const scanCommand = new ScanCommand(scanParams);
        const result = await docClient.send(scanCommand);

        if (result.Items && result.Items.length > 0) {
          console.log(`Processing ${result.Items.length} items`);

          if (result.Items.length > 0) {
            console.log(
              "Sample item structure:",
              JSON.stringify(result.Items[0], null, 2)
            );
          }

          const batchResults = await processItemsBatch(result.Items);
          processedCount += result.Items.length;
          successCount += batchResults.successCount;
          errorCount += batchResults.errorCount;
        }

        lastEvaluatedKey = result.LastEvaluatedKey;
        hasMoreItems = !!lastEvaluatedKey;

        if (hasMoreItems) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } catch (scanError) {
        console.error("Error scanning DynamoDB table:", scanError);
        errorCount++;

        if (scanError.name === "ProvisionedThroughputExceededException") {
          console.log("Throughput exceeded, waiting before retry...");
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        throw scanError;
      }
    }

    const duration = Date.now() - startTime;
    const successMessage = `Successfully processed ${processedCount} items (${successCount} successful, ${errorCount} errors) in ${duration}ms`;
    console.log(successMessage);

    const jobSummary = {
      processedCount,
      successCount,
      errorCount,
      duration,
      startTime,
      tableName: TABLE_NAME,
      bucketName: S3_BUCKET_NAME,
      expirationDays: PRESIGNED_URL_EXPIRATION_DAYS,
      status: jobStatus,
    };

    await sendJobSummaryEmail(jobSummary);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: successMessage,
        processedCount,
        successCount,
        errorCount,
        duration,
      }),
    };
  } catch (error) {
    jobStatus = "failed";
    jobError = error.message;

    const errorMessage = `Error in presigned URL regeneration: ${error.message}`;
    console.error(errorMessage, error);

    const jobSummary = {
      processedCount,
      successCount,
      errorCount,
      duration: Date.now() - startTime,
      startTime,
      tableName: TABLE_NAME || "Unknown",
      bucketName: S3_BUCKET_NAME || "Unknown",
      expirationDays: PRESIGNED_URL_EXPIRATION_DAYS,
      status: jobStatus,
      error: jobError,
    };

    await sendJobSummaryEmail(jobSummary);

    return {
      statusCode: 500,
      body: JSON.stringify({
        message: errorMessage,
        processedCount,
        successCount,
        errorCount,
        error: error.message,
      }),
    };
  }
};
