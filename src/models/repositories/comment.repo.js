const { convertToObjectId } = require("../../utils");

const CommentModel = require("../comment.model");

const createNewComment = async (payload) => {
  const comment = await CommentModel.create(payload);
  return comment;
};

const findMaxRightValue = async (product_id) => {
  const maxRightValue = await CommentModel.findOne({
    comment_product_id: convertToObjectId(product_id),
  }).sort({
    comment_right: -1,
  });
  return maxRightValue;
};

const findCommentById = async (comment_id) => {
  const comment = await CommentModel.findById(convertToObjectId(comment_id));
  return comment;
};

const updateRightComment = async (product_id, rightValue) => {
  return await CommentModel.updateMany(
    {
      comment_product_id: convertToObjectId(product_id),
      comment_right: { $gte: rightValue },
    },
    {
      $inc: { comment_right: 2 },
    }
  );
};

const updateLeftComment = async (product_id, rightValue) => {
  return await CommentModel.updateMany(
    {
      comment_product_id: convertToObjectId(product_id),
      comment_left: { $gt: rightValue },
    },
    {
      $inc: { comment_left: 2 },
    }
  );
};

const findCommentsByProductId = async ({ product_id }) => {
  console.log("product_id", product_id);
  const comment = await CommentModel.find({
    comment_product_id: convertToObjectId(product_id),
  }).select({
    comment_content: 1,
    comment_left: 1,
    comment_right: 1,
    comment_parent_id: 1,
  });
  return comment;
};

const findCommentsByParentId = async (parent_id, product_id) => {
  const parent = await CommentModel.findById(parent_id);
  if (!parent) throw new Error("No comment found");
  const comments = await CommentModel.find({
    comment_product_id: convertToObjectId(product_id),
    comment_left: { $gt: parent.comment_left },
    comment_right: { $lt: parent.comment_right },
  })
    .select({
      comment_content: 1,
      comment_left: 1,
      comment_right: 1,
      comment_parent_id: 1,
    })
    .sort({
      comment_left: 1,
    });
  return comments;
};

const deleteCommentByProductId = async ({
  product_id,
  leftValue,
  rightValue,
}) => {
  await CommentModel.deleteMany({
    comment_product_id: product_id,
    comment_left: { $gte: leftValue, $lte: rightValue },
  });
  const width = rightValue - leftValue + 1;
  await CommentModel.updateMany(
    {
      comment_product_id: product_id,
      comment_left: { $gt: rightValue },
    },
    {
      $inc: { comment_left: -width },
    }
  );
  await CommentModel.updateMany(
    {
      comment_product_id: product_id,
      comment_right: { $gt: rightValue },
    },
    {
      $inc: { comment_right: -width },
    }
  );
};

module.exports = {
  createNewComment,
  findMaxRightValue,
  findCommentById,
  updateRightComment,
  updateLeftComment,
  findCommentsByProductId,
  findCommentsByParentId,
  deleteCommentByProductId,
};
