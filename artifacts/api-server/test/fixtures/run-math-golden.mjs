export const runMathGoldenProfile = {
  brand: "Lucia",
  flavor: "Golden sampler",
  revision: 4,
  productData: {
    sources: [
      {
        brand: "Lucia",
        sourceName: "Synthetic product specifications",
        content: {
          format: "lucia.product-spec.v1",
          sections: [{
            sheet: "OZ",
            headerRow: 1,
            unit: "oz",
            targetWeight: "18.5",
            weightSpecRange: "18.25 - 18.75",
            notes: [],
            warnings: [],
            ingredients: [
              { name: "Lucia Dough", sourceRow: 2, amounts: [{ column: "B", value: "8" }] },
              { name: "Lucia Sauce", sourceRow: 3, ingredientRole: "sauce", amounts: [{ column: "B", value: "2" }] },
              { name: "Lucia Cheese Mix", sourceRow: 4, ingredientRole: "cheese_applicator", amounts: [{ column: "B", value: "3" }] },
              { name: "Tray", sourceRow: 5, amounts: [{ column: "B", value: "1" }] },
            ],
          }],
        },
      },
      {
        brand: "Lucia",
        sourceName: "Synthetic dough guide",
        content: {
          format: "lucia.operational-workbook.v1",
          importKind: "dough_guide",
          sheets: [{
            name: "Dough",
            recipes: [{
              name: "Lucia Dough",
              source: { sheet: "Dough", startRow: 1 },
              ingredients: [
                { name: "Flour", amounts: [{ column: 2, label: "2 Bag", value: 160 }] },
                { name: "Water", amounts: [{ column: 2, label: "2 Bag", value: 40 }] },
              ],
              total: { amounts: [{ column: 2, label: "2 Bag", value: 200 }] },
              dough: {
                batches: [{ column: 2, label: "2 Bag", unit: "lb", total: 200 }],
                issues: [],
              },
              steps: [],
              notes: [],
            }],
          }],
        },
      },
      {
        brand: "Lucia",
        sourceName: "Synthetic sauce guide",
        content: {
          format: "lucia.operational-workbook.v1",
          importKind: "sauce_guide",
          sheets: [{
            name: "Sauce",
            recipes: [{
              name: "Lucia Sauce",
              source: { sheet: "Sauce", startRow: 1 },
              ingredients: [
                { name: "Tomatoes", amounts: [{ column: 2, label: "Batch lbs", value: 40 }] },
                { name: "Water", amounts: [{ column: 2, label: "Batch lbs", value: 10 }] },
              ],
              total: { amounts: [{ column: 2, label: "Batch lbs", value: 50 }] },
              steps: [],
              notes: [],
            }],
          }],
        },
      },
      {
        brand: "Lucia",
        sourceName: "Synthetic cheese guide",
        content: {
          format: "lucia.operational-workbook.v1",
          importKind: "cheese",
          sheets: [{
            name: "Cheese",
            recipes: [{
              name: "Lucia Cheese Mix",
              source: { sheet: "Cheese", startRow: 1 },
              ingredients: [
                { name: "Mozzarella", amounts: [{ column: 2, label: "Batch lbs", value: 12 }] },
                { name: "Cheese blend", amounts: [{ column: 2, label: "Batch lbs", value: 8 }] },
              ],
              total: { amounts: [{ column: 2, label: "Batch lbs", value: 20 }] },
              steps: [],
              notes: [],
            }],
          }],
        },
      },
    ],
  },
};
