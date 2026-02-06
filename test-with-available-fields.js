import fetch from 'node-fetch';

async function testWithAvailableFields() {
    console.log('\n=== Testing with Available Fields ===');
    console.log('Group by customer_id from invoices and sum their invoice amounts');
    
    // Query: Group by customer_id in invoices and sum their invoice amounts
    const queryData = {
        database: 'salesDB',
        filters: [
            { collection: 'customers', field: 'region', operator: 'eq', value: 'West' }
        ],
        aggregation: [
            { 
                operator: 'sum', 
                collection: 'invoices', 
                field: 'total_amount', 
                alias: 'total_invoice_amount' 
            }
        ],
        groupBy: [
            { collection: 'invoices', field: 'customer_id' }  // Group by customer_id from invoices
        ],
        having: [
            { 
                field: 'total_invoice_amount', 
                operator: 'gt', 
                value: '1000' 
            }
        ]
    };
    
    try {
        const response = await fetch('http://localhost:3000/query', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(queryData),
        });
        
        const result = await response.json();
        console.log('Status:', response.status);
        console.log('Success:', result.success);
        console.log('Type:', result.type);
        console.log('Detailed count:', result.detailed_count);
        console.log('Aggregation count:', result.aggregation_count);
        
        if (result.aggregation_data && result.aggregation_data.length > 0) {
            console.log('\nAggregation Results (customers with total > 1000):');
            result.aggregation_data.forEach((agg, index) => {
                const customerId = agg._id && agg._id.customer_id ? agg._id.customer_id : 'Unknown';
                const totalAmount = agg.total_invoice_amount;
                console.log(`  Customer ID: ${customerId}, Total = ${totalAmount}`);
            });
        } else {
            console.log('\nNo customers found with total invoice amount > 1000');
        }
        
        if (result.detailed_data && result.detailed_data.length > 0) {
            console.log('\nDetailed Results (invoices from qualifying customers):');
            
            // Group detailed results by customer to verify totals
            const invoicesByCustomer = {};
            result.detailed_data.forEach((invoice, index) => {
                const customerId = invoice.customer_id;
                const customerName = invoice.customers_name || 'Unknown';
                
                if (!invoicesByCustomer[customerId]) {
                    invoicesByCustomer[customerId] = {
                        name: customerName,
                        invoices: [],
                        total: 0
                    };
                }
                
                invoicesByCustomer[customerId].invoices.push(invoice.total_amount);
                invoicesByCustomer[customerId].total += invoice.total_amount;
                
                console.log(`  Invoice ${index + 1}: ${customerName} (ID: ${customerId}), Amount: ${invoice.total_amount}`);
            });
            
            console.log('\nVerification - Customer Totals:');
            Object.entries(invoicesByCustomer).forEach(([customerId, data]) => {
                console.log(`  ${data.name}: ${data.invoices.length} invoices totaling ${data.total}`);
                console.log(`    Individual amounts: [${data.invoices.join(', ')}]`);
            });
        } else {
            console.log('\nNo detailed records found (no customers met the condition)');
        }
        
        console.log('\nThis test uses the available field:');
        console.log('- Group by: invoices.customer_id (available in the field list)');
        console.log('- Calculate: sum of invoices.total_amount');
        console.log('- Condition: total > 1000');
        
    } catch (error) {
        console.error('Error:', error.message);
    }
}

// Run the test
testWithAvailableFields();