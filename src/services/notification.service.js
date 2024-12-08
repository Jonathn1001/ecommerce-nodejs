"use strict";

const { NOTIFICATION_TYPES } = require("../constants");
const NotificationModel = require("../models/notification.model");
const { convertToObjectId } = require("../utils");

const pushNotification = async ({
  type = "",
  sender = "",
  receiver = "",
  options = {},
}) => {
  let content = "";
  // Push notification to the receiver
  switch (type) {
    case NOTIFICATION_TYPES.PROMOTION_CREATED:
      content = `New Product: ${options.product_name} created by ${sender}`;
      break;
    case NOTIFICATION_TYPES.ORDER_CREATED:
      content = `Order created by ${sender}`;
      break;
    case NOTIFICATION_TYPES.PROMOTION_CREATED:
      content = `Promotion created by ${sender}`;
      break;
    case NOTIFICATION_TYPES.SHOP_FOLLOWED:
      content = `New Shop By User Followed`;
      break;
    default:
      break;
  }

  const newNotification = await NotificationModel.create({
    notification_type: type,
    notification_sender_id: sender,
    notification_receiver_id: receiver,
    notification_content: content,
    notification_options: options,
  });

  return newNotification;
};

const getListNotification = async ({ user_id, type = "ALL", isRead = 0 }) => {
  let match = {
    notification_receiver_id: convertToObjectId(user_id),
  };
  if (type !== "ALL") {
    match["notification_type"] = type;
  }
  return await NotificationModel.aggregate([
    { $match: match },
    {
      $project: {
        notification_type: 1,
        notification_sender_id: 1,
        notification_receiver_id: 1,
        notification_content: 1,
        created_at: 1,
      },
    },
  ]);
};

module.exports = {
  pushNotification,
  getListNotification,
};
