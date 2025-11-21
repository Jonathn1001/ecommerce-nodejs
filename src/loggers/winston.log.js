"use strict";

const winston = require("winston");
const { createLogger, format, transports } = winston;
require("winston-daily-rotate-file");
const { combine, timestamp, printf } = format;
const { v4: uuid } = require("uuid");

/**
 * TODO: LOG Format
 * @Author : String
 * @Date : Date
 * @LastEditor : String
 * @LastEditTime : Date
 * @FilePath : String
 * @Description : String
 * CopyRight by : Elgnas All Rights Reserved
 */
class WinsonLogger {
  constructor({ level = "info" }) {
    this.logger = createLogger({
      level,
      format: combine(
        timestamp({
          format: "YYYY-MM-DD HH:mm:ss",
        }),
        printf(
          ({ level, message, timestamp, requestId, context, metadata }) => {
            return `${timestamp}::${level}::${message}::${requestId}::${context}::${JSON.stringify(
              metadata
            )}`;
          }
        )
      ),
      transports: [
        new transports.Console(),
        new transports.DailyRotateFile({
          level,
          dirname: `logs/${level}`, // directory to save the log files
          filename: `application-%DATE%.${level}.log`, // file name pattern for the log files
          datePattern: "YYYY-MM-DD-HH-mm-ss",
          zippedArchive: true, // compress the log file before file rotation
          maxSize: "10m", // size of the log file
          maxFiles: "14d", // keep logs for 14 days
        }),
      ],
    });
  }

  paramsDestructor(params) {
    let context, req, metadata;
    if (Array.isArray(params)) {
      [context, req, metadata] = params;
    } else {
      ({ context, req, metadata } = params);
    }
    const requestId = req?.requestId || uuid();

    return {
      requestId,
      context,
      metadata,
    };
  }

  info(message, params) {
    const logObject = Object.assign(
      {
        message,
      },
      this.paramsDestructor(params)
    );
    this.logger.info(logObject);
  }
  error(message, params) {
    const logObject = Object.assign(
      {
        message,
      },
      this.paramsDestructor(params)
    );
    this.logger.error(logObject);
  }
}

module.exports = WinsonLogger;
