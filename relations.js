const RELATIONS = 
[
  { 
    from: "customers", 
    to: "invoices", 
    local: "_id", 
    foreign: "customer_id" 
  },
  { 
    from: "products", 
    to: "invoices", 
    local: "_id", 
    foreign: "product_id" 
  },
  { 
    from: "categories", 
    to: "products", 
    local: "_id", 
    foreign: "category_id" 
  },
  { 
    from: "categories", 
    to: "invoices", 
    local: "_id", 
    foreign: "category_id" 
  }
];

export default RELATIONS;
