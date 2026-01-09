/**
 * Database Error Handler Middleware
 * Handles database connection errors, retries, and provides user-friendly messages
 */

const RETRY_DELAY = 1000; // 1 second
const MAX_RETRIES = 3;

/**
 * Wrap database operations with error handling and retry logic
 */
async function withRetry(operation, options = {}) {
  const { maxRetries = MAX_RETRIES, retryDelay = RETRY_DELAY } = options;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      console.error(`❌ Database operation failed (attempt ${attempt}/${maxRetries}):`, error.message);

      // Don't retry on certain errors
      if (isNonRetryableError(error)) {
        break;
      }

      // Wait before retrying
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay * attempt));
      }
    }
  }

  throw lastError;
}

/**
 * Check if error should not be retried
 */
function isNonRetryableError(error) {
  // Don't retry validation errors, authentication errors, etc.
  const nonRetryableCodes = [
    11000, // Duplicate key error
    121, // Document failed validation
  ];

  if (error.code && nonRetryableCodes.includes(error.code)) {
    return true;
  }

  // Don't retry authorization errors
  if (error.message && error.message.includes("auth")) {
    return true;
  }

  return false;
}

/**
 * Get user-friendly error message
 */
function getUserFriendlyMessage(error) {
  if (error.code === 11000) {
    return "A record with this information already exists";
  }

  if (error.code === 121) {
    return "The data provided is invalid";
  }

  if (error.name === "ValidationError") {
    return "Please check your input and try again";
  }

  if (error.name === "CastError") {
    return "Invalid data format provided";
  }

  if (error.message && error.message.includes("connection")) {
    return "Database connection error. Please try again";
  }

  if (error.message && error.message.includes("timeout")) {
    return "Request timed out. Please try again";
  }

  return "An error occurred while processing your request";
}

/**
 * Database error handler middleware
 */
function dbErrorHandler(err, req, res, next) {
  console.error("❌ Database error:", err);

  // Get user-friendly message
  const userMessage = getUserFriendlyMessage(err);

  // Determine status code
  let statusCode = 500;
  if (err.code === 11000) {
    statusCode = 409; // Conflict
  } else if (err.name === "ValidationError" || err.code === 121) {
    statusCode = 400; // Bad Request
  } else if (err.name === "CastError") {
    statusCode = 400; // Bad Request
  }

  // Send error response
  res.status(statusCode).json({
    message: userMessage,
    error: process.env.NODE_ENV === "development" ? err.message : undefined,
    code: err.code,
  });
}

/**
 * Async route handler wrapper with error handling
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  withRetry,
  getUserFriendlyMessage,
  isNonRetryableError,
  dbErrorHandler,
  asyncHandler,
};

