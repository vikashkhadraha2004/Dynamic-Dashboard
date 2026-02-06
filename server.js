import express from "express";
import cors from "cors";
import rateLimit from 'express-rate-limit';
import 'dotenv/config';
import { getDB } from "./db.js";
import { buildJoinPlan } from "./joinPlanner.js";
import { buildMatch } from "./filterBuilder.js";
import OPERATORS from './operators.js';
import { ObjectId } from 'mongodb';

const app = express();

// Rate limiting middleware
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});
//////////////////////////////////////////////////////

app.use('/query', limiter); // Apply to your query endpoint security layer

// Custom sanitization middleware
function sanitizeInput(req, res, next) {
  if (req.body && req.body.filters && Array.isArray(req.body.filters)) {
    for (const filter of req.body.filters) {
      // Sanitize collection names
      if (typeof filter.collection === 'string') {
        filter.collection = filter.collection.replace(/[^a-zA-Z0-9_]/g, '');
      }
      // Sanitize field names
      if (typeof filter.field === 'string') {
        filter.field = filter.field.replace(/[.$]/g, ''); // Remove dangerous chars
      }
      // Sanitize operator names
      if (typeof filter.operator === 'string') {
        filter.operator = filter.operator.replace(/[^a-zA-Z0-9_]/g, '');
      }
    }
  }
  next();
}

app.use('/query', sanitizeInput); // Apply sanitization

app.use(cors());
app.use(express.json({
  // Limit payload size to prevent large request attacks
  limit: '10mb'
}));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(express.static("public"));

function resolveRoot(filters) {
  const cols = [...new Set(filters.map(f => f.collection))];
  
  // If invoices is one of the collections being filtered, make it the root
  if (cols.includes('invoices')) {
    return 'invoices';
  }
  
  // If there are multiple collections being filtered, default to invoices
  // since it's the central transactional collection
  if (cols.length > 1) {
    return 'invoices';
  }
  
  // If only one collection is being filtered, check if it has relationships
  // to invoices - if so, use invoices as root to allow proper joins
  const relatedToInvoices = ['customers', 'products', 'categories'];
  if (cols.length === 1 && relatedToInvoices.includes(cols[0])) {
    return 'invoices';
  }
  
  // Otherwise, use the collection directly
  return cols[0] || 'invoices';
}

function resolveFieldPath(root, f) {
  return f.collection === root ? f.field : `${f.collection}.${f.field}`;
}

function validateFilter(filter) {
  // Validate collection name (whitelist approach)
  const allowedCollections = ['invoices', 'customers', 'products', 'categories'];
  if (!allowedCollections.includes(filter.collection)) {
    throw new Error(`Invalid collection: ${filter.collection}`);
  }
  
  // Validate field names (prevent special MongoDB operators)
  if (typeof filter.field === 'string' && (filter.field.includes('$') || filter.field.includes('.'))) {
    throw new Error(`Invalid field name: ${filter.field}`);
  }
  
  // Validate operator (whitelist approach)
  const allowedOperators = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith', 'endsWith', 'between', 'in', 'regex', 'sum', 'avg', 'min', 'max', 'count'];
  if (!allowedOperators.includes(filter.operator)) {
    throw new Error(`Invalid operator: ${filter.operator}`);
  }
  
  // Validate value types
  if (typeof filter.value === 'object' && filter.value !== null && !Array.isArray(filter.value)) {
    // Allow objects for 'between' operator
    if (filter.operator !== 'between') {
      throw new Error('Object values not allowed for security reasons');
    }
  }
  
  return true;
}

// Build pipeline for detailed records (without aggregation)
function buildDetailedRecordsPipeline(filters) {
  const pipeline = [];
  
  // Build joins if needed
  const root = resolveRoot(filters);
  const joins = buildJoinPlan(root, filters);
  
  joins.forEach(j => {
    pipeline.push({
      $lookup: {
        from: j.from,
        localField: j.localField,
        foreignField: j.foreignField,
        as: j.as
      }
    });
    pipeline.push({ $unwind: `$${j.as}` });
  });
  
  // Add match stage for filters
  if (filters.length > 0) {
    const matchFilters = filters.map(f => ({
      field: resolveFieldPath(root, f),
      operator: f.operator,
      value: f.value
    })).filter(f => !['sum', 'avg', 'min', 'max', 'count'].includes(f.operator));
    
    if (matchFilters.length > 0) {
      pipeline.push({ $match: buildMatch(matchFilters) });
    }
  }
  
  return pipeline;
}

// Unified aggregation pipeline builder for complex queries with filters, aggregations, and HAVING
function buildAggregationPipeline(filters, aggregationOps = [], havingFilters = [], groupByFields = []) {
  const pipeline = [];
  
  // Build joins if needed
  const root = resolveRoot(filters);
  const joins = buildJoinPlan(root, filters);
  
  joins.forEach(j => {
    pipeline.push({
      $lookup: {
        from: j.from,
        localField: j.localField,
        foreignField: j.foreignField,
        as: j.as
      }
    });
    pipeline.push({ $unwind: `$${j.as}` });
  });
  
  // Add match stage for filters (WHERE clause)
  if (filters.length > 0) {
    const matchFilters = filters.map(f => ({
      field: resolveFieldPath(root, f),
      operator: f.operator,
      value: f.value
    })).filter(f => !['sum', 'avg', 'min', 'max', 'count'].includes(f.operator));
    
    if (matchFilters.length > 0) {
      pipeline.push({ $match: buildMatch(matchFilters) });
    }
  }
  
  // Add aggregation stages if needed
  if (aggregationOps.length > 0) {
    // Determine grouping fields - for now, we'll group by all available fields if groupByFields is provided
    // If no specific groupByFields are provided, we group all together for overall aggregates
    let groupStage = groupByFields && groupByFields.length > 0 ? { _id: {} } : { _id: null };
    
    // Add grouping fields to the _id object if specified
    if (groupByFields && groupByFields.length > 0) {
      groupByFields.forEach(fieldObj => {
        const fieldName = resolveFieldPath(root, fieldObj);
        groupStage._id[fieldObj.field] = `$${fieldName}`;
      });
    }
    
    aggregationOps.forEach(op => {
      if (op.operator === 'count') {
        groupStage[op.alias || 'count'] = { $sum: 1 };
      } else if (['sum', 'avg', 'min', 'max'].includes(op.operator)) {
        const fieldName = resolveFieldPath(root, { collection: op.collection, field: op.field });
        groupStage[op.alias || op.operator] = { 
          [`$${op.operator}`]: `$${fieldName}` 
        };
      }
    });
    
    pipeline.push({ $group: groupStage });
  }

  // Add post-aggregation match stage (HAVING clause)
  if (havingFilters.length > 0) {
    const havingMatch = {};
    
    havingFilters.forEach(h => {
      // Resolve field paths for HAVING clause (these refer to aggregation results)
      const field = h.field;  // In HAVING, this refers to the aggregation result field
      const operator = h.operator;
      const value = h.value;
      
      if (!OPERATORS[operator]) {
        throw new Error(`Invalid operator in HAVING clause: ${operator}`);
      }
      
      const condition = OPERATORS[operator](value);
      
      if (!havingMatch[field]) {
        havingMatch[field] = condition;
      } else {
        Object.assign(havingMatch[field], condition);
      }
    });
    
    if (Object.keys(havingMatch).length > 0) {
      pipeline.push({ $match: havingMatch });
    }
  }
  
  return pipeline;
}

app.post("/query", async (req, res) => {
  try {
    const { database, filters = [], aggregation = [], having = [], groupBy = [] } = req.body;
    
    if (!database) {
      return res.status(400).json({ error: "Database name is required" });
    }
    
    const db = await getDB(database);

    let detailedData = [];
    let aggregationData = [];
    let response = {};

    if (aggregation && aggregation.length > 0) {
      // When aggregation is present, use the unified aggregation pipeline
      const aggregationPipeline = buildAggregationPipeline(filters, aggregation, having, groupBy);
      aggregationData = await db.collection(resolveRoot(filters)).aggregate(aggregationPipeline, { allowDiskUse: true }).toArray();
      
      // For detailed records when HAVING is used, we need to get records that would contribute 
      // to the aggregated results that passed the HAVING condition
      let detailedPipeline = [];
      
      // Build the base pipeline with joins and filters (same as aggregation pipeline up to group stage)
      const root = resolveRoot(filters);
      const joins = buildJoinPlan(root, filters);
      
      joins.forEach(j => {
        detailedPipeline.push({
          $lookup: {
            from: j.from,
            localField: j.localField,
            foreignField: j.foreignField,
            as: j.as
          }
        });
        detailedPipeline.push({ $unwind: `$${j.as}` });
      });
      
      // Add match stage for filters (WHERE clause)
      if (filters.length > 0) {
        const matchFilters = filters.map(f => ({
          field: resolveFieldPath(root, f),
          operator: f.operator,
          value: f.value
        })).filter(f => !['sum', 'avg', 'min', 'max', 'count'].includes(f.operator));
        
        if (matchFilters.length > 0) {
          detailedPipeline.push({ $match: buildMatch(matchFilters) });
        }
      }
      
      // If HAVING conditions exist and we want to filter detailed records based on the aggregation groups that passed HAVING,
      // we need to identify which entities (e.g. customers) met the HAVING criteria and only return records related to those entities
      if (having.length > 0 && groupBy.length > 0) {
        // We need to identify which group values passed the HAVING conditions
        // Then filter the detailed records to only include those that match those group values
        
        // Get the group IDs/values that passed HAVING from aggregation results
        const passingGroups = aggregationData.map(result => result._id);
        
        // If we have passing groups, filter detailed records to only include those that belong to these groups
        if (passingGroups.length > 0) {
          // Create a match condition to filter detailed records based on the group fields
          const groupMatchConditions = {};
          
          // For each groupBy field, add conditions to match records that belong to passing groups
          groupBy.forEach((gb, index) => {
            const fieldName = resolveFieldPath(root, gb);
            // Extract the values for this group field from the passing groups
            const values = passingGroups
              .filter(g => g && g[gb.field]) // Only consider groups that have this field
              .map(g => g[gb.field]);
              
            if (values.length > 0) {
              groupMatchConditions[fieldName] = { $in: values };
            }
          });
          
          // Add the group matching condition to the detailed pipeline
          if (Object.keys(groupMatchConditions).length > 0) {
            detailedPipeline.push({ $match: groupMatchConditions });
          }
        } else {
          // If no groups passed the HAVING condition, we should return empty detailed results
          // Add a condition that will never match anything to return empty results
          detailedPipeline.push({ $match: { _id: null } }); // This will result in empty set
        }
      }
      
      detailedData = await db.collection(resolveRoot(filters)).aggregate(detailedPipeline, { allowDiskUse: true }).toArray();
      
      // Enhance detailed records to include requested field values from joined collections
      const enhancedDetailedData = await enhanceResultsWithJoinedFields(db, detailedData, filters);
      
      response = {
        success: true,
        type: 'both',
        detailed_pipeline: detailedPipeline,
        aggregation_pipeline: aggregationPipeline,
        detailed_count: detailedData.length,
        aggregation_count: aggregationData.length,
        detailed_data: enhancedDetailedData,
        aggregation_data: aggregationData
      };
    } else {
      // Handle regular query (backward compatibility)
      const root = resolveRoot(filters);
      const joins = buildJoinPlan(root, filters);
      
      let pipeline = [];
      
      joins.forEach(j => {
        pipeline.push({
          $lookup: {
            from: j.from,
            localField: j.localField,
            foreignField: j.foreignField,
            as: j.as
          }
        });
        pipeline.push({ $unwind: `$${j.as}` });
      });
      
      // Validate filters
      for (const f of filters) {
        validateFilter(f);
        if (!f.collection || !f.field || !f.operator) {
          return res.status(400).json({ 
            error: "Each filter must have collection, field, and operator" 
          });
        }
      }

      // Validate having filters
      for (const h of having) {
        // Validate field names (prevent special MongoDB operators)
        if (typeof h.field === 'string' && (h.field.includes('$') || h.field.includes('.'))) {
          throw new Error(`Invalid field name in having clause: ${h.field}`);
        }
        // Validate operator
        const allowedOperators = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'];
        if (!allowedOperators.includes(h.operator)) {
          throw new Error(`Invalid operator in having clause: ${h.operator}`);
        }
      }
      
      const matchFilters = filters.map(f => ({
        field: resolveFieldPath(root, f),
        operator: f.operator,
        value: f.value
      }));
      
      if (matchFilters.length) {
        pipeline.push({ $match: buildMatch(matchFilters) });
      }
      
      detailedData = await db.collection(root).aggregate(pipeline, { allowDiskUse: true }).toArray();
          
      // Enhance results to include requested field values from joined collections
      const enhancedData = await enhanceResultsWithJoinedFields(db, detailedData, filters);
      
      response = {
        success: true,
        type: 'regular',
        root,
        pipeline,
        count: detailedData.length,
        data: enhancedData
      };
    }
    
    res.json(response);
  } catch (err) {
    // Check if this is a validation error (user-generated) or internal error
    if (err.message.includes('Invalid') || err.message.includes('validation')) {
      console.error('Validation error:', err);
      res.status(400).json({ error: err.message });
    } else {
      console.error('Query error:', err); // Log full error for debugging
      // Send generic error message to prevent information disclosure
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// GET endpoint to fetch all available fields
app.get("/all-fields/:database", async (req, res) => {
  try {
    const { database } = req.params;
    const db = await getDB(database);
    
    // Get collections and their fields
    const collections = await db.listCollections().toArray();
    const fields = [];
    
    for (const coll of collections) {
      const sampleDoc = await db.collection(coll.name).findOne();
      if (sampleDoc) {
        Object.keys(sampleDoc).forEach(key => {
          if (key !== "_id") { // Skip _id field
            fields.push({
              collection: coll.name,
              value: key
            });
          }
        });
      }
    }
    
    res.json({ fields });
  } catch (err) {
    console.error('All-fields error:', err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DEBUG endpoint to inspect collection data
app.get("/debug/:database/:collection", async (req, res) => {
  try {
    const { database, collection } = req.params;
    const db = await getDB(database);
    
    // Get sample documents
    const samples = await db.collection(collection).find().limit(5).toArray();
    
    // Get distinct values for specific fields
    let distinctRegions = [];
    let distinctZones = [];
    let dateRange = {};
    
    try {
      distinctRegions = await db.collection(collection).distinct('region');
      distinctZones = await db.collection(collection).distinct('zone');
      
      // Get min/max dates
      const dates = await db.collection(collection)
        .aggregate([
          { $match: { invoice_date: { $exists: true } } },
          { $project: { date: { $dateFromString: { dateString: "$invoice_date" } } } },
          { $group: { _id: null, min: { $min: "$date" }, max: { $max: "$date" } } }
        ]).toArray();
      
      if (dates.length > 0) {
        dateRange = {
          min: dates[0].min,
          max: dates[0].max
        };
      }
    } catch (err) {
      console.log(`Could not get distinct values for ${collection}:`, err.message);
    }
    
    res.json({
      collection,
      sampleDocuments: samples,
      distinctRegions: distinctRegions || [],
      distinctZones: distinctZones || [],
      dateRange: dateRange,
      totalDocuments: await db.collection(collection).estimatedDocumentCount()
    });
  } catch (err) {
    console.error('Debug endpoint error:', err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Function to enhance results with joined field information
async function enhanceResultsWithJoinedFields(db, data, filters) {
  if (!data || data.length === 0) return data;
  
  // Identify which collections were joined based on the filters
  const joinedCollections = new Set();
  filters.forEach(filter => {
    if (filter.collection !== 'invoices') { // assuming invoices is usually root
      joinedCollections.add(filter.collection);
    }
  });
  
  // Create a map of ID fields to collection mappings
  const idFieldMappings = {
    'customer_id': 'customers',
    'product_id': 'products',
    'category_id': 'categories'
  };
  
  // Process each record to add meaningful field information
  const enhancedRecords = [];
  
  for (const record of data) {
    const enhancedRecord = { ...record };
    
    // Check for ID fields in the root record and resolve them to names
    for (const [idField, collection] of Object.entries(idFieldMappings)) {
      if (enhancedRecord[idField]) {
        // Get the name/label for this ID from the corresponding collection
        const idValue = enhancedRecord[idField];
        
        try {
          // Fetch the document with this ID from the appropriate collection
          const doc = await db.collection(collection).findOne({ _id: idValue });
          if (doc) {
            // Find a suitable name field in the document
            const nameField = doc.name || doc.title || doc.label || doc._id;
            
            // Add a new field with the resolved name
            enhancedRecord[`${collection}_name`] = nameField;
            
            // Optionally, also add other useful fields
            if (doc.name) enhancedRecord[`${collection}_name`] = doc.name;
            if (doc.region) enhancedRecord[`customer_region`] = doc.region;
            if (doc.zone) enhancedRecord[`customer_zone`] = doc.zone;
          }
        } catch (error) {
          console.warn(`Could not resolve ${idField} to ${collection} name:`, error.message);
        }
      }
    }
    
    enhancedRecords.push(enhancedRecord);
  }
  
  return enhancedRecords;
}

// Save query configuration endpoint
app.post("/save-query-config", async (req, res) => {
  try {
    const { name, description, filters = [], aggregation = [], having = [], groupBy = [] } = req.body;
    if (!name) return res.status(400).json({ error: "Name is required" });
    const db = await getDB(process.env.STORAGE_DB || 'queryStorage');
    const queryConfig = {
      _id: new ObjectId(),
      name,
      description,
      filters,
      aggregation,
      having,
      groupBy,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await db.collection('queryConfigs').insertOne(queryConfig);
    res.json({ success: true, id: queryConfig._id });
  } catch (err) {
    console.error('Save query config error:', err);
    res.status(500).json({ error: "Failed to save query config" });
  }
});

// Get all saved query configurations
app.get("/query-configs", async (req, res) => {
  try {
    const db = await getDB(process.env.STORAGE_DB || 'queryStorage');
    const configs = await db.collection('queryConfigs').find({}).sort({ createdAt: -1 }).toArray();
    res.json({ configs });
  } catch (err) {
    console.error('Fetch configs error:', err);
    res.status(500).json({ error: "Failed to fetch query configs" });
  }
});

// Delete saved query configuration
app.delete("/query-config/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDB(process.env.STORAGE_DB || 'queryStorage');
    const result = await db.collection('queryConfigs').deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete config error:', err);
    res.status(500).json({ error: "Failed to delete query config" });
  }
});

app.listen(3000, () =>
  console.log("Server running at http://localhost:3000")
);
