/** A company to scan: a careers URL plus a display name and optional categories. */
export type CompanyLead = {
  company: string;
  careersUrl: string;
  categories: string[];
};
