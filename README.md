# E-Commerce Backend API

A robust and scalable e-commerce backend API built with Node.js, designed to handle all aspects of an online store including product management, user authentication, shopping cart functionality, order processing, and more.

## Description

This project serves as a comprehensive backend solution for e-commerce applications, providing RESTful APIs for:

- **User Management**: Authentication and authorization with JWT tokens
- **Product Catalog**: Product creation, management, and categorization (Electronics, Clothing, Furniture, Motorbike)
- **Shopping Cart**: Add, update, remove products from cart
- **Discount System**: Create and manage discount codes with various rules
- **Order Management**: Complete checkout process with order tracking
- **Inventory Management**: Stock tracking and reservation system
- **Comment System**: Product reviews and nested comments
- **Notification System**: Real-time notifications for various events
- **File Upload**: Image upload to Cloudinary and AWS S3
- **Message Queuing**: RabbitMQ and Kafka integration for async processing

## Tech Stack

### Core Technologies

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: MongoDB with Mongoose ODM
- **Authentication**: JWT (JSON Web Tokens)
- **Password Hashing**: bcrypt

### Cloud Services

- **Image Storage**: Cloudinary
- **File Storage**: AWS S3
- **Database**: MongoDB Atlas (production ready)

### Message Queuing & Caching

- **Message Broker**: RabbitMQ
- **Event Streaming**: Apache Kafka
- **Caching**: Redis (for distributed locking)

### Development Tools

- **Process Manager**: PM2
- **Environment Management**: dotenv
- **File Upload**: Multer
- **Logging**: Winston (implied from logs structure)
- **API Documentation**: Built-in documentation endpoint
- **Testing**: Custom test implementations for messaging systems

### Security & Middleware

- **Security Headers**: Helmet.js
- **Compression**: Express compression
- **CORS**: Cross-Origin Resource Sharing support
- **Rate Limiting**: Built-in protection mechanisms
- **API Key Authentication**: Custom middleware

### Utilities

- **Slug Generation**: Slugify
- **Data Manipulation**: Lodash
- **Date Handling**: Custom date utilities
- **Object ID Handling**: MongoDB ObjectId utilities

## Architecture Features

### Design Patterns

- **Factory Pattern**: Product creation system
- **Repository Pattern**: Data access layer abstraction
- **Service Layer**: Business logic separation
- **MVC Architecture**: Clean separation of concerns

### Database Design

- **Product Variants**: Support for different product types (Electronics, Clothing, etc.)
- **Flexible Schema**: Mixed type attributes for product specifications
- **Optimized Queries**: Proper indexing and lean queries
- **Aggregation Pipelines**: Complex data retrieval operations

### Advanced Features

- **Distributed Locking**: Redis-based inventory reservation
- **Event-Driven Architecture**: RabbitMQ pub/sub patterns
- **Microservice Ready**: Modular service architecture
- **Error Handling**: Comprehensive error management system
- **API Versioning**: Version-controlled endpoints
- **Environment Configuration**: Multi-environment support (dev, ci, production)

## Project Structure
