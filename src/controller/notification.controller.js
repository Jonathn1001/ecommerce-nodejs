"use strict";

const { catchAsync } = require("../helpers");
const { SuccessResponse } = require("../utils/SuccessResponse");
const { getListNotification } = require("./../services/notification.service");

class NotificationController {
  getNotificationsByUser = catchAsync(async (req, res) => {
    return new SuccessResponse({
      message: "Notification retrieved successfully",
      metadata: await getListNotification(req.query),
    }).send(res);
  });
}

module.exports = new NotificationController();
