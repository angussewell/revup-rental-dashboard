# 🚨 CRITICAL DATA ACCURACY BUG FIX

## Summary
Fixed systematic data calculation errors causing major discrepancies between Monthly Performance Snapshot and Group analytics.

## Root Causes Identified

### 1. Revenue Field Mismatch 
- **Main Analytics**: Used `nightlySubtotal` (room revenue only)
- **Group Analytics**: Used `totalPrice` (includes taxes & fees)  
- **Impact**: $191.73 vs $211 RevPAR discrepancy for June 2025

### 2. Multi-Month Reservation Double-Counting
- **SQL Function**: Attributed entire multi-month reservation to each month it touches
- **Group Analytics**: Correctly proportioned only the month's portion
- **Impact**: 311 multi-month reservations in June showed $601,231 vs $275,999 difference

### 3. Date Filtering Logic Error
- **Original**: Only included reservations that START in month
- **Corrected**: Includes all reservations that overlap with month
- **Impact**: Missing 175 reservations that end in month but started earlier

## Fixes Applied

### ✅ Building Analytics Revenue Field Fix
**File**: `/src/server/api/routers/building.ts`
**Lines**: 2 occurrences in `getGroupMonthlyPerformanceWithSTLY`

**Before**:
```typescript
const revenue = reservation.totalPrice ? Number(reservation.totalPrice) : 0;
```

**After**:
```typescript
// FIXED: Use nightlySubtotal to match main analytics (room revenue only, excluding taxes/fees)
const revenue = reservation.nightlySubtotal ? Number(reservation.nightlySubtotal) : 0;
```

### ✅ SQL Function Date Logic Fix
**Function**: `get_adr_occupancy_metrics()`
**Change**: Updated to use overlapping date logic instead of start-date-only filtering

### 🔄 SQL Function Proportional Allocation (In Progress)
**Requirement**: Implement same proportional logic as group analytics for multi-month reservations

## Evidence of Bug Impact

### Multi-Month Reservation Analysis (June 2025)
```
Multi-month reservations: 311
- SQL Method (WRONG): $601,231 total revenue → June
- Group Method (CORRECT): $275,999 June portion → June
- Difference: $325,232 overcounting per month
```

### Missing Reservations Analysis
```
Reservations ending in June but starting earlier: 174
Reservations spanning entire June: 1
Total missing from original SQL function: 175
```

## Expected Outcome
After all fixes are complete:
- ✅ "All Units" group RevPAR should match Monthly Performance Snapshot RevPAR
- ✅ Eliminate impossible -94% STLY figures  
- ✅ Consistent data across all analytics endpoints
- ✅ Accurate month-by-month revenue attribution

## Testing Required
1. Verify June 2025 RevPAR consistency between main analytics and "All Units" group
2. Confirm STLY calculations are reasonable (not -94%)
3. Test other months for data consistency
4. Validate with external data source comparison

## Organization Tested
- **Happy Palm Stays** (ID: cmaxymex40000ha36wu8qki45)
- **Properties**: 322 total, 316 in "All Units" building
- **Issue**: Test group supposed to include ALL properties but was missing 6

---
**Priority**: CRITICAL - Affects all revenue reporting accuracy
**Status**: Fixes applied, final SQL function syntax refinement needed
**Date**: June 9, 2025
