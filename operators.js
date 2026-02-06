import { ObjectId } from 'mongodb';

// Regular operators
function maybeNumber(v) {
  // Don't convert values that look like ObjectIds (hex strings with letters)
  if (typeof v === "string" && 
      v.match(/^[0-9a-fA-F]{24}$/)) { // 24-char hex string like ObjectId
    try {
      return new ObjectId(v);
    } catch (e) {
      return v; // fallback to original value if not valid ObjectId
    }
  }
  
  if (typeof v === "string" && v.trim() !== "" && !isNaN(v)) {
    return Number(v);
  }
  return v;
}

function maybeDate(v) {
  // Check if it looks like a date string (YYYY-MM-DD or DD-MM-YYYY)
  if (typeof v === "string") {
    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
      const date = new Date(v);
      if (date.toString() !== 'Invalid Date') return date;
    }
    // DD-MM-YYYY or DD/MM/YYYY
    const dmyMatch = v.match(/^(\d{2})[-/](\d{2})[-/](\d{4})/);
    if (dmyMatch) {
      const [_, day, month, year] = dmyMatch;
      const date = new Date(`${year}-${month}-${day}`);
      if (date.toString() !== 'Invalid Date') return date;
    }
  }
  return v;
}

// Aggregation operators
const AGGREGATION_OPERATORS = {
  sum: '$sum',
  avg: '$avg',
  min: '$min',
  max: '$max',
  count: '$sum', // Count using sum with value 1
  first: '$first',
  last: '$last'
};

// Standard comparison operators
const STANDARD_OPERATORS = {
  eq: v => ({ $eq: maybeDate(maybeNumber(v)) }),
  ne: v => ({ $ne: maybeDate(maybeNumber(v)) }),
  gt: v => ({ $gt: maybeDate(maybeNumber(v)) }),
  gte: v => ({ $gte: maybeDate(maybeNumber(v)) }),
  lt: v => ({ $lt: maybeDate(maybeNumber(v)) }),
  lte: v => ({ $lte: maybeDate(maybeNumber(v)) }),

  startsWith: v => ({ $regex: `^${v}`, $options: "i" }),
  endsWith: v => ({ $regex: `${v}$`, $options: "i" }),
  contains: v => ({ $regex: v, $options: "i" }),

  in: v => ({ $in: Array.isArray(v) ? v.map(item => {
    // Handle ObjectIds in arrays
    if (typeof item === "string" && item.match(/^[0-9a-fA-F]{24}$/)) {
      try {
        return new ObjectId(item);
      } catch (e) {
        return item;
      }
    }
    return maybeDate(maybeNumber(item));
  }) : [v] }),

  between: v => ({
    $gte: maybeDate(maybeNumber(v.from)),
    $lte: maybeDate(maybeNumber(v.to))
  })
};

// Combined operators
const OPERATORS = {
  ...STANDARD_OPERATORS,
  ...AGGREGATION_OPERATORS
};

export { AGGREGATION_OPERATORS };
export default OPERATORS;
