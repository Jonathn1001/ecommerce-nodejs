"use strict";

const {
  createNewComment,
  findMaxRightValue,
  findCommentById,
  findCommentsByParentId,
  updateRightComment,
  updateLeftComment,
  findCommentsByProductId,
  deleteCommentByProductId,
} = require("../models/repositories/comment.repo");
const { findProductById } = require("../models/repositories/product.repo");
const { BadRequestError, NotFoundError } = require("../utils/AppError");

/**
 * TODO: Implement the comment service
 * - Create a new comment [User|Shop]
 * - Update a comment [User|Shop]
 * - Delete a comment [Shop|Admin]
 * - Get all comments [User|Shop|Admin]
 */

class CommentService {
  static async createComment({ product_id, user_id, content, parent_id }) {
    // ? Check if product exists
    const product = await findProductById({ product_id });
    if (!product) throw new NotFoundError("Product not found");
    const comment = await createNewComment({
      comment_product_id: product_id,
      comment_user_id: user_id,
      comment_content: content,
      comment_parent_id: parent_id,
    });
    // ? Calculate the left and right values of the comment
    let rightValue;
    if (parent_id) {
      // ? If the comment has a parent, then we need to update the right value of the parent comment
      const parentComment = await findCommentById(parent_id);
      if (!parentComment) {
        throw new NotFoundError("Parent comment not found");
      }
      rightValue = parentComment.comment_right;
      await updateRightComment(product_id, rightValue);
      await updateLeftComment(product_id, rightValue);
    } else {
      // ? If the comment does not have a parent, then we need to find the right value of the last comment
      const maxRightValue = await findMaxRightValue(product_id);
      if (maxRightValue) {
        rightValue = maxRightValue.comment_right + 1;
      } else {
        rightValue = 1;
      }
    }
    // ? Update the comment with the right value
    comment.comment_left = rightValue;
    comment.comment_right = rightValue + 1;
    await comment.save();
    return comment;
  }

  static async getCommentsByProductId({ product_id }) {
    // ? Get all comments with the same product_id
    if (!product_id) throw new BadRequestError("Product id is required");
    const comments = await findCommentsByProductId({ product_id });
    return comments;
  }

  static async getCommentById({ comment_id }) {
    // ? Get comment by comment_id
    if (!comment_id) throw new BadRequestError("Comment id is required");
    const comment = await findCommentById(comment_id);
    return comment;
  }

  static async getCommentsByParentId({ parent_id, product_id }) {
    // ? Get all comments with the same parent_id
    if (!parent_id) throw new BadRequestError("Parent comment id is required");
    const comments = await findCommentsByParentId(parent_id, product_id);
    return comments;
  }

  static async deleteComments({ comment_id, product_id }) {
    // ? Check if product exists
    const product = await findProductById({ product_id });
    if (!product) throw new NotFoundError("Product not found");
    // ? Find the comment by comment_id
    const comment = await findCommentById(comment_id);
    if (!comment) throw new NotFoundError("Comment not found");
    console.log(comment);
    // ? Find the left and right values of the comment
    const leftValue = comment.comment_left;
    const rightValue = comment.comment_right;
    // ? Calculate the difference between the left and right values
    await deleteCommentByProductId({ product_id, leftValue, rightValue });
    return true;
  }
}

module.exports = CommentService;
