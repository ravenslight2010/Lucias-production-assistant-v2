// Minimal source excerpts from the named customer workbooks. Source row
// numbers and labels are retained so role tests protect real workbook variants
// without checking the full customer files into the repository.
export const customerProductSpecFixtures = [
  {
    sourceWorkbook: "Aldo's_Pizza_Specs_-_09_1794437757780.xlsx",
    sheet: "OZ",
    brand: "Aldo's",
    flavor: "CHEESE",
    targetWeight: "17.8",
    weightSpecRange: "17.55 - 18.05",
    rows: [
      { row: 2, cells: ["Aldo's", " CHEESE"] },
      { row: 3, cells: ["Parbake crust (Aldo's recipe - 12\" Dies)", 6.5, 7.7] },
      { row: 4, cells: ["Aldo's Sauce (made in house)", 4] },
      {
        row: 5,
        cells: [
          "Applicator - Aldo's Cheese Mix\n2.07 Pizella, 1.19 Part Skim Mozzarella, 0.26 Grated Parmesan, 0.13 Oregano Flake",
          3.65,
          3.5,
          3.5,
        ],
      },
      {
        row: 6,
        cells: [
          "Applicator - Aldo's Cheese Mix\n2.07 Pizella, 1.19 Part Skim Mozzarella, 0.26 Grated Parmesan, 0.13 Oregano Flake",
          3.65,
          0.2,
          0.1,
        ],
      },
      { row: 7, cells: ["TARGET WEIGHT", 17.8] },
      { row: 8, cells: ["WEIGHT SPEC RANGE", "17.55 - 18.05"] },
    ],
    expectedRows: [
      { row: 3, name: "Parbake crust (Aldo's recipe - 12\" Dies)", role: "ingredient" },
      { row: 4, name: "Aldo's Sauce (made in house)", role: "sauce" },
      {
        row: 5,
        name: "Applicator - Aldo's Cheese Mix\n2.07 Pizella, 1.19 Part Skim Mozzarella, 0.26 Grated Parmesan, 0.13 Oregano Flake",
        role: "cheese_applicator",
      },
      {
        row: 6,
        name: "Applicator - Aldo's Cheese Mix\n2.07 Pizella, 1.19 Part Skim Mozzarella, 0.26 Grated Parmesan, 0.13 Oregano Flake",
        role: "cheese_applicator",
      },
    ],
  },
  {
    sourceWorkbook: "Lucia_Pizza_Recipe_Specs_-_35_1794437759636.xlsx",
    sheet: "OZ",
    brand: "Lucia's New & Improved Pizzas",
    flavor: "PEPPERONI",
    targetWeight: "18.5",
    weightSpecRange: "18.25 - 18.75",
    rows: [
      { row: 10, cells: ["Lucia's New & Improved Pizzas ", "PEPPERONI"] },
      { row: 11, cells: ['Parbake crust (CRB Recipe - 12" Dies)', 7.5] },
      { row: 12, cells: ["Lucia's Sauce (Lucia's Recipe)", 4] },
      {
        row: 13,
        cells: [
          "Applicator - Lucia's Standard Cheese Mix                                                           \n1.59 Pizella, 0.91 Whole Mozzarella",
          2.5,
        ],
      },
      { row: 14, cells: ["Pepperoni Stick (Cured Sugardale - 01874)", "19 = 1.5"] },
      {
        row: 15,
        cells: [
          "Applicator - Lucia's Pepperoni Cheese Mix                                                           \n1.62 Pizella, 0.92 Whole Mozzarella, 0.46 Diced Pepperoni",
          3,
        ],
      },
      { row: 16, cells: ["TARGET WEIGHT", 18.5] },
      { row: 17, cells: ["WEIGHT SPEC RANGE", "18.25 - 18.75"] },
    ],
    expectedRows: [
      { row: 11, name: 'Parbake crust (CRB Recipe - 12" Dies)', role: "ingredient" },
      { row: 12, name: "Lucia's Sauce (Lucia's Recipe)", role: "sauce" },
      {
        row: 13,
        name: "Applicator - Lucia's Standard Cheese Mix                                                           \n1.59 Pizella, 0.91 Whole Mozzarella",
        role: "cheese_applicator",
      },
      { row: 14, name: "Pepperoni Stick (Cured Sugardale - 01874)", role: "ingredient" },
      {
        row: 15,
        name: "Applicator - Lucia's Pepperoni Cheese Mix                                                           \n1.62 Pizella, 0.92 Whole Mozzarella, 0.46 Diced Pepperoni",
        role: "pep_applicator",
      },
    ],
  },
  {
    sourceWorkbook: "Lowe's_7_Inch_Pizza_Specs_-_06_1794437759391.xlsx",
    sheet: "Sheet1",
    brand: "7\" Lowe's Pizzas",
    flavor: "PEPPERONI",
    targetWeight: "8.5",
    weightSpecRange: "8.35 - 8.65",
    rows: [
      { row: 21, cells: ["7\" Lowe's Pizzas ", "PEPPERONI  "] },
      { row: 22, cells: [null, "OZ"] },
      { row: 23, cells: ['Parbake Crust (7" CRB recipe - 7" Dies)', 5.2] },
      { row: 24, cells: ["Lucia's Sauce (Lucia's Recipe)", 1.3] },
      {
        row: 25,
        cells: [
          "Applicator - Lowe's Pepperoni Cheese Mix                                                                     \n0.44 P/S Mozz, 0.26 Provolone",
          0.7,
        ],
      },
      { row: 26, cells: ["Pepperoni Stick - NATURAL (Hormel 24878)", "6 = 0.5"] },
      {
        row: 27,
        cells: [
          "Applicator - Lowe's Pepperoni/Romano Cheese Mix                                                                     \n0.44 P/S Mozz, 0.26 Provolone, 0.1 SHEEP Romano",
          0.8,
        ],
      },
      { row: 28, cells: ["TARGET WEIGHT", 8.5] },
      { row: 29, cells: ["WEIGHT SPEC RANGE", "8.35 - 8.65"] },
    ],
    expectedRows: [
      { row: 23, name: "Parbake Crust (7\" CRB recipe - 7\" Dies)", role: "ingredient" },
      { row: 24, name: "Lucia's Sauce (Lucia's Recipe)", role: "sauce" },
      {
        row: 25,
        name: "Applicator - Lowe's Pepperoni Cheese Mix                                                                     \n0.44 P/S Mozz, 0.26 Provolone",
        role: "pep_applicator",
      },
      { row: 26, name: "Pepperoni Stick - NATURAL (Hormel 24878)", role: "ingredient" },
      {
        row: 27,
        name: "Applicator - Lowe's Pepperoni/Romano Cheese Mix                                                                     \n0.44 P/S Mozz, 0.26 Provolone, 0.1 SHEEP Romano",
        role: "pep_applicator",
      },
    ],
  },
  {
    sourceWorkbook: "Corner_Booth_Recipe_Specs_-_24_1794437758825.xlsx",
    sheet: "OZ",
    brand: "Corner Booth Pizzas",
    flavor: "SUPREME",
    targetWeight: "23.75",
    weightSpecRange: "23.5 - 24.0",
    rows: [
      { row: 20, cells: ["Corner Booth Pizzas ", "SUPREME"] },
      { row: 21, cells: ["Parbake crust (CRB Recipe - 12\" Dies)", 7.25] },
      { row: 22, cells: ["Sauce (Mystic Recipe)", 6] },
      { row: 23, cells: ["Applicator - Italian Sausage (C&F - 001LPIS40)", 2.5] },
      { row: 24, cells: ["Applicator - Whole Mozzarella", 3] },
      { row: 25, cells: ["Pepperoni Stick (Cured Sugardale - 01874)", "11 = 0.75"] },
      {
        row: 26,
        cells: [
          "Applicator - White Fajita Mix\n0.563 Blanched White Onion Strips, 0.563 Blanched Green Pepper Strips, 0.563 Blanched Red Pepper Strips, 0.563 Blanched Yellow Pepper Strips",
          2.25,
        ],
      },
      { row: 27, cells: ["Applicator - Whole Mozzarella", 2] },
      { row: 28, cells: ["TARGET WEIGHT", 23.75] },
      { row: 29, cells: ["WEIGHT SPEC RANGE", "23.5 - 24.0"] },
    ],
    expectedRows: [
      { row: 21, name: "Parbake crust (CRB Recipe - 12\" Dies)", role: "ingredient" },
      { row: 22, name: "Sauce (Mystic Recipe)", role: "sauce" },
      { row: 23, name: "Applicator - Italian Sausage (C&F - 001LPIS40)", role: "ingredient" },
      { row: 24, name: "Applicator - Whole Mozzarella", role: "cheese_applicator" },
      { row: 25, name: "Pepperoni Stick (Cured Sugardale - 01874)", role: "ingredient" },
      {
        row: 26,
        name: "Applicator - White Fajita Mix\n0.563 Blanched White Onion Strips, 0.563 Blanched Green Pepper Strips, 0.563 Blanched Red Pepper Strips, 0.563 Blanched Yellow Pepper Strips",
        role: "ingredient",
      },
      { row: 27, name: "Applicator - Whole Mozzarella", role: "cheese_applicator" },
    ],
  },
];
