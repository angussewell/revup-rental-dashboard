/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { db as prismaClient } from "~/server/db";
import { startOfMonth, endOfMonth, subMonths, subDays, format, isAfter, isBefore, differenceInDays, subYears, addMonths } from 'date-fns';
import { validatePropertyOwnership } from '~/server/api/utils/security';
import axios from 'axios';
import { env } from '~/env';
import { Decimal } from '@prisma/client/runtime/library';

// Market data API client setup
const keyDataApiClient = axios.create({
  baseURL: env.KEY_DATA_API_BASE_URL || 'https://api.keydata.com',
  headers: {
    'Authorization': `Bearer ${env.KEY_DATA_API_KEY || ''}`,
    'Content-Type': 'application/json'
  },
  timeout: 30000,
});

// Type definitions for Key Data API responses
interface KeyDataPropertyPerformance {
  property_name: string;
  date: string;
  adr: number;
  occupancy: number;
  revPar: number;
  revenue: number;
  roomNights: number;
}

interface KeyDataAmenities {
  balcony: boolean;
  pool: boolean;
  hotTub: boolean;
  petFriendly: boolean;
  beachfront: boolean;
  skiInSkiOut: boolean;
  evCharger: boolean;
}

interface KeyDataMarketOverview {
  marketId: string;
  marketName: string;
  date: string;
  listings: number;
  adr: number;
  medianAdr: number;
  occupancy: number;
  revenue: number;
  revPar: number;
  availableListings: number;
  bookedListings: number;
}

// Response schema for market overview data
const keyDataMarketOverviewSchema = z.object({
  marketId: z.string(),
  marketName: z.string(),
  date: z.string(),
  listings: z.number(),
  adr: z.number(),
  medianAdr: z.number(),
  occupancy: z.number(),
  revenue: z.number(),
  revPar: z.number(),
  availableListings: z.number(),
  bookedListings: z.number(),
});

// Comprehensive output schema including all metrics (ADR, Occupancy, RevPAR)
const comprehensiveAnalyticsOutputSchema = z.object({
  MonthYear: z.string(), // ISO string format
  Current_ADR: z.number().nullable(),
  STLY_ADR: z.number().nullable(),
  CurrentUserOccupancy: z.number().nullable(),
  CurrentUserSTLYOccupancy: z.number().nullable(),
  CurrentUserRevPAR: z.number().nullable(),
  CurrentUserSTLYRevPAR: z.number().nullable(),
  Market_ADR_Current: z.number().nullable(),
  MarketOccupancyCurrent: z.number().nullable(),
  MarketRevPARCurrent: z.number().nullable(),
});

// Schema for portfolio monthly outlook
const portfolioMonthlyOutlookMetricSchema = z.object({
  currentProjection: z.number().nullable(),
  stlyActual: z.number().nullable(),
  varianceVsStly: z.object({
    absolute: z.number().nullable(),
    percentage: z.number().nullable(),
  }),
  wowPickup: z.number().nullable(),
});

const portfolioMonthlyOutlookSchema = z.object({
  month: z.string(), // ISO date string
  monthDisplay: z.string(), // Formatted display string (e.g., "June 2025")
  metrics: z.object({
    adr: portfolioMonthlyOutlookMetricSchema,
    occupancy: portfolioMonthlyOutlookMetricSchema,
    revpar: portfolioMonthlyOutlookMetricSchema,
  }),
});

// Schema for weekly pacing (WoW pickup only)
const weeklyPacingSchema = z.object({
  month: z.string(), // ISO date string
  monthDisplay: z.string(), // Formatted display string (e.g., "June 2025")
  wowPickup: z.object({
    adr: z.number().nullable(),
    occupancy: z.number().nullable(),
    revpar: z.number().nullable(),
  }),
});

// Key Data API response types
interface KeyDataMarketBreakdownItem {
  date: string;
  adr: number;
  occupancy: number;
  revPar: number;
  revenue?: number;
  roomNights?: number;
}

interface KeyDataMarketBreakdownResponse {
  marketId: string;
  breakdown: KeyDataMarketBreakdownItem[];
}

export const analyticsRouter = createTRPCRouter({
  // Procedure for fetching property performance data (ADR, Occupancy)
  getPropertyPerformance: protectedProcedure
    .input(z.object({
      organizationId: z.string(),
    }))
    .query(async ({ ctx, input }) => {
      const { organizationId } = input;
      const userId = ctx.session.user.id;

      // Verify user has access to this organization
      const userOrg = await ctx.db.userOrganization.findFirst({
        where: { 
          userId,
          organizationId,
        },
      });
      
      if (!userOrg) {
        throw new Error("Organization not found or access denied");
      }

      // Execute the SQL view query
      const rawData = await ctx.db.$queryRaw<Array<{
        MonthYear: Date;
        Current_ADR: Decimal | null;
        STLY_ADR: Decimal | null;
        CurrentUserOccupancy: Decimal | null;
        CurrentUserSTLYOccupancy: Decimal | null;
      }>>`
        SELECT 
          "MonthYear", 
          "Current_ADR", 
          "STLY_ADR",
          "CurrentUserOccupancy",
          "CurrentUserSTLYOccupancy"
        FROM "PropertyPerformanceOutlook_View"
        ORDER BY "MonthYear" ASC
      `;

      // Transform the data to ensure proper number conversion
      const performanceData = rawData.map(row => ({
        MonthYear: row.MonthYear.toISOString(),
        Current_ADR: row.Current_ADR === null ? null : Number(row.Current_ADR),
        STLY_ADR: row.STLY_ADR === null ? null : Number(row.STLY_ADR),
        CurrentUserOccupancy: row.CurrentUserOccupancy === null ? null : Number(row.CurrentUserOccupancy),
        CurrentUserSTLYOccupancy: row.CurrentUserSTLYOccupancy === null ? null : Number(row.CurrentUserSTLYOccupancy),
      }));

      return performanceData;
    }),

  // Comprehensive procedure that includes ADR, Occupancy, and RevPAR data
  getComprehensiveAnalytics: protectedProcedure
    .input(z.object({
      organizationId: z.string(),
    }))
    .output(z.array(comprehensiveAnalyticsOutputSchema))
    .query(async ({ ctx, input }) => {
      const { organizationId } = input;
      const userId = ctx.session.user.id;

      // Debug: Log the request
      console.log('[Comprehensive Analytics] Starting request for organization:', organizationId);

      // Verify user has access to this organization
      const userOrg = await ctx.db.userOrganization.findFirst({
        where: { 
          userId,
          organizationId,
        },
      });
      
      if (!userOrg) {
        throw new Error("Organization not found or access denied");
      }

      // Execute the SQL view query
      // This now includes RevPAR fields
      const rawData = await ctx.db.$queryRaw<Array<{
        MonthYear: Date;
        Current_ADR: any; // Decimal object or null
        STLY_ADR: any; // Decimal object or null
        CurrentUserOccupancy: any; // Decimal object or null
        CurrentUserSTLYOccupancy: any; // Decimal object or null
        CurrentUserRevPAR: any; // Decimal object or null
        CurrentUserSTLYRevPAR: any; // Decimal object or null
      }>>`
        SELECT 
          "MonthYear", 
          "Current_ADR", 
          "STLY_ADR",
          "CurrentUserOccupancy",
          "CurrentUserSTLYOccupancy",
          "CurrentUserRevPAR",
          "CurrentUserSTLYRevPAR"
        FROM get_adr_occupancy_metrics(${organizationId}::text)
        ORDER BY "MonthYear" ASC
      `;

      // Debug: Log raw data from database
      console.log('[Comprehensive Analytics] Raw data count:', rawData.length);
      console.log('[Comprehensive Analytics] First 3 months from DB:', 
        rawData.slice(0, 3).map(d => ({ 
          month: format(d.MonthYear, 'yyyy-MM'), 
          adr: d.Current_ADR,
          occupancy: d.CurrentUserOccupancy,
          revpar: d.CurrentUserRevPAR 
        }))
      );

      // Transform the data to ensure proper number conversion
      const outlookData = rawData.map(row => ({
        MonthYear: row.MonthYear,
        Current_ADR: row.Current_ADR === null ? null : Number(row.Current_ADR),
        STLY_ADR: row.STLY_ADR === null ? null : Number(row.STLY_ADR),
        CurrentUserOccupancy: row.CurrentUserOccupancy === null ? null : Number(row.CurrentUserOccupancy),
        CurrentUserSTLYOccupancy: row.CurrentUserSTLYOccupancy === null ? null : Number(row.CurrentUserSTLYOccupancy),
        CurrentUserRevPAR: row.CurrentUserRevPAR === null ? null : Number(row.CurrentUserRevPAR),
        CurrentUserSTLYRevPAR: row.CurrentUserSTLYRevPAR === null ? null : Number(row.CurrentUserSTLYRevPAR),
      }));

      // Debug: Log transformed data before market fetch
      console.log('[Comprehensive Analytics] Transformed data for first 3 months:', 
        outlookData.slice(0, 3).map(d => ({ 
          month: format(d.MonthYear, 'yyyy-MM'), 
          userRevPAR: d.CurrentUserRevPAR 
        }))
      );

      try {
        // Fetch organization to get marketId
        const organization = await ctx.db.organization.findUnique({
          where: { id: organizationId },
          select: { marketId: true },
        });

        if (organization?.marketId) {
          console.log('[Comprehensive Analytics] Fetching market data for marketId:', organization.marketId);
          
          try {
            // Fetch market data from Key Data API
            const marketDataResponse = await keyDataApiClient.get<KeyDataMarketBreakdownResponse>(
              `/v2/markets/${organization.marketId}/performance/breakdown`,
              {
                params: {
                  start_date: format(outlookData[0].MonthYear, 'yyyy-MM-dd'),
                  end_date: format(outlookData[outlookData.length - 1].MonthYear, 'yyyy-MM-dd'),
                  aggregation: 'monthly',
                },
              }
            );

            // Process market data (ADR, Occupancy, and RevPAR)
            const marketDataMap = new Map<string, {
              adr: number[];
              occupancy: number[];
              revpar: number[];
            }>();

            // Initialize map for all months
            for (const data of outlookData) {
              const monthKey = format(data.MonthYear, 'yyyy-MM');
              marketDataMap.set(monthKey, {
                adr: [],
                occupancy: [],
                revpar: [],
              });
            }

            // Collect RevPAR data - using standard revPar field
            if (marketDataResponse.data?.breakdown) {
              for (const item of marketDataResponse.data.breakdown) {
                const monthKey = format(new Date(item.date), 'yyyy-MM');
                const monthData = marketDataMap.get(monthKey);
                if (monthData) {
                  monthData.adr.push(item.adr);
                  monthData.occupancy.push(item.occupancy);
                  monthData.revpar.push(item.revPar);
                }
              }
            }

            // Log decision about RevPAR field choice
            console.log('[Comprehensive Analytics] RevPAR Field Selection: Using "revPar" field from Key Data API');

            // Calculate averages for each month
            const marketAverages = new Map<string, {
              adr: number | null;
              occupancy: number | null;
              revpar: number | null;
            }>();

            for (const [monthKey, data] of marketDataMap.entries()) {
              marketAverages.set(monthKey, {
                adr: data.adr.length > 0 ? data.adr.reduce((sum, val) => sum + val, 0) / data.adr.length : null,
                occupancy: data.occupancy.length > 0 ? data.occupancy.reduce((sum, val) => sum + val, 0) / data.occupancy.length : null,
                revpar: data.revpar.length > 0 ? data.revpar.reduce((sum, val) => sum + val, 0) / data.revpar.length : null,
              });
              console.log(`[Comprehensive Analytics] ${monthKey}: ADR values: ${data.adr.length}, Occ values: ${data.occupancy.length}, RevPAR values: ${data.revpar.length}`);
            }

            // Map market data to results
            const filteredMarketData = new Map<string, {
              adr: number | null;
              occupancy: number | null;
              revpar: number | null;
            }>();
            
            for (const data of outlookData) {
              const monthKey = format(data.MonthYear, 'yyyy-MM');
              const marketData = marketAverages.get(monthKey) || { adr: null, occupancy: null, revpar: null };
              filteredMarketData.set(monthKey, marketData);
            }

            const resultsWithMarket = outlookData.map(row => {
              const monthKey = format(row.MonthYear, 'yyyy-MM');
              const marketData = filteredMarketData.get(monthKey) || { adr: null, occupancy: null, revpar: null };
              return {
                MonthYear: row.MonthYear.toISOString(),
                Current_ADR: row.Current_ADR,
                STLY_ADR: row.STLY_ADR,
                CurrentUserOccupancy: row.CurrentUserOccupancy,
                CurrentUserSTLYOccupancy: row.CurrentUserSTLYOccupancy,
                CurrentUserRevPAR: row.CurrentUserRevPAR,
                CurrentUserSTLYRevPAR: row.CurrentUserSTLYRevPAR,
                Market_ADR_Current: marketData.adr,
                MarketOccupancyCurrent: marketData.occupancy,
                MarketRevPARCurrent: marketData.revpar,
              };
            });

            // Debug: Log final output with market data
            console.log('[Comprehensive Analytics] First 3 months with market data:', 
              resultsWithMarket.slice(0, 3).map(d => ({ 
                month: format(new Date(d.MonthYear), 'yyyy-MM'), 
                userRevPAR: d.CurrentUserRevPAR,
                marketRevPAR: d.MarketRevPARCurrent
              }))
            );

            return resultsWithMarket;
          } catch (marketError) {
            console.error('[Comprehensive Analytics] Error fetching market data:', marketError);
            // Return data without market info
            return outlookData.map(row => ({
              MonthYear: row.MonthYear.toISOString(),
              Current_ADR: row.Current_ADR,
              STLY_ADR: row.STLY_ADR,
              CurrentUserOccupancy: row.CurrentUserOccupancy,
              CurrentUserSTLYOccupancy: row.CurrentUserSTLYOccupancy,
              CurrentUserRevPAR: row.CurrentUserRevPAR,
              CurrentUserSTLYRevPAR: row.CurrentUserSTLYRevPAR,
              Market_ADR_Current: null,
              MarketOccupancyCurrent: null,
              MarketRevPARCurrent: null,
            }));
          }
        } else {
          console.log('[Comprehensive Analytics] No marketId found for organization');
          // Return data without market info
          return outlookData.map(row => ({
            MonthYear: row.MonthYear.toISOString(),
            Current_ADR: row.Current_ADR,
            STLY_ADR: row.STLY_ADR,
            CurrentUserOccupancy: row.CurrentUserOccupancy,
            CurrentUserSTLYOccupancy: row.CurrentUserSTLYOccupancy,
            CurrentUserRevPAR: row.CurrentUserRevPAR,
            CurrentUserSTLYRevPAR: row.CurrentUserSTLYRevPAR,
            Market_ADR_Current: null,
            MarketOccupancyCurrent: null,
            MarketRevPARCurrent: null,
          }));
        }
      } catch (error) {
        console.error('[Comprehensive Analytics] Unexpected error:', error);
        // Return data without market info
        return outlookData.map(row => ({
          MonthYear: row.MonthYear.toISOString(),
          Current_ADR: row.Current_ADR,
          STLY_ADR: row.STLY_ADR,
          CurrentUserOccupancy: row.CurrentUserOccupancy,
          CurrentUserSTLYOccupancy: row.CurrentUserSTLYOccupancy,
          CurrentUserRevPAR: row.CurrentUserRevPAR,
          CurrentUserSTLYRevPAR: row.CurrentUserSTLYRevPAR,
          Market_ADR_Current: null,
          MarketOccupancyCurrent: null,
          MarketRevPARCurrent: null,
        }));
      }
    }),

  // Get portfolio monthly outlook with current projections vs STLY actuals
  getPortfolioMonthlyOutlook: protectedProcedure
    .input(z.object({
      organizationId: z.string(),
    }))
    .output(z.array(portfolioMonthlyOutlookSchema))
    .query(async ({ ctx, input }) => {
      const { organizationId } = input;
      const userId = ctx.session.user.id;
      const today = new Date();
      const sevenDaysAgo = subDays(today, 7);

      // Verify user has access to this organization
      const userOrg = await ctx.db.userOrganization.findFirst({
        where: { 
          userId,
          organizationId,
        },
      });
      
      if (!userOrg) {
        throw new Error("Organization not found or access denied");
      }

      // Get active properties
      const properties = await ctx.db.property.findMany({
        where: {
          organizationId,
          isActive: true,
        },
        select: {
          id: true,
        },
      });

      const propertyIds = properties.map(p => p.id);
      const activeProperties = properties.filter(p => p !== null);

      if (activeProperties.length === 0) {
        return [];
      }

      // Get next 12 months starting from current month
      const months: Date[] = [];
      for (let i = 0; i < 12; i++) {
        months.push(startOfMonth(addMonths(today, i)));
      }

      // Process each month
      const monthlyData = await Promise.all(months.map(async (monthStart) => {
        const monthEnd = endOfMonth(monthStart);
        const monthDisplay = format(monthStart, 'MMMM yyyy');
        const stlyMonthStart = subYears(monthStart, 1);
        const stlyMonthEnd = endOfMonth(stlyMonthStart);

        // Get current projections
        const currentReservations = await ctx.db.wheelhouseReservation.findMany({
          where: {
            propertyId: { in: propertyIds },
            bookedAt: { lte: today },
            status: { notIn: ['cancelled', 'declined'] },
            OR: [
              {
                startDate: { gte: monthStart, lte: monthEnd }
              },
              {
                endDate: { gte: monthStart, lte: monthEnd }
              },
              {
                startDate: { lt: monthStart },
                endDate: { gt: monthEnd }
              }
            ]
          },
          select: {
            startDate: true,
            endDate: true,
            totalPrice: true,
            nightlySubtotal: true,
          }
        });

        // Get projections from 7 days ago
        const weekAgoReservations = await ctx.db.wheelhouseReservation.findMany({
          where: {
            propertyId: { in: propertyIds },
            bookedAt: { lte: sevenDaysAgo },
            status: { notIn: ['cancelled', 'declined'] },
            OR: [
              {
                startDate: { gte: monthStart, lte: monthEnd }
              },
              {
                endDate: { gte: monthStart, lte: monthEnd }
              },
              {
                startDate: { lt: monthStart },
                endDate: { gt: monthEnd }
              }
            ]
          },
          select: {
            startDate: true,
            endDate: true,
            totalPrice: true,
            nightlySubtotal: true,
          }
        });

        // Get STLY actuals (reservations from last year, booked by this time last year)
        const stlyReservations = await ctx.db.wheelhouseReservation.findMany({
          where: {
            propertyId: { in: propertyIds },
            bookedAt: { lte: subYears(today, 1) },
            status: { notIn: ['cancelled', 'declined'] },
            OR: [
              {
                startDate: { gte: stlyMonthStart, lte: stlyMonthEnd }
              },
              {
                endDate: { gte: stlyMonthStart, lte: stlyMonthEnd }
              },
              {
                startDate: { lt: stlyMonthStart },
                endDate: { gt: stlyMonthEnd }
              }
            ]
          },
          select: {
            startDate: true,
            endDate: true,
            totalPrice: true,
            nightlySubtotal: true,
          }
        });

        // Calculate metrics for each dataset
        const currentMetrics = calculateMonthMetrics(currentReservations, monthStart, monthEnd, activeProperties.length);
        const weekAgoMetrics = calculateMonthMetrics(weekAgoReservations, monthStart, monthEnd, activeProperties.length);
        const stlyMetrics = calculateMonthMetrics(stlyReservations, stlyMonthStart, stlyMonthEnd, activeProperties.length);

        // Calculate variances
        const adrVariance = currentMetrics.adr !== null && stlyMetrics.adr !== null 
          ? currentMetrics.adr - stlyMetrics.adr 
          : null;
        const adrVariancePercentage = calculatePercentageChange(currentMetrics.adr, stlyMetrics.adr);
        const adrWowPickup = currentMetrics.adr !== null && weekAgoMetrics.adr !== null 
          ? currentMetrics.adr - weekAgoMetrics.adr 
          : null;

        const occupancyVariance = currentMetrics.occupancy !== null && stlyMetrics.occupancy !== null 
          ? currentMetrics.occupancy - stlyMetrics.occupancy 
          : null;
        const occupancyVariancePercentage = calculatePercentageChange(currentMetrics.occupancy, stlyMetrics.occupancy);
        const occupancyWowPickup = currentMetrics.occupancy !== null && weekAgoMetrics.occupancy !== null 
          ? currentMetrics.occupancy - weekAgoMetrics.occupancy 
          : null;

        const revparVariance = currentMetrics.revpar !== null && stlyMetrics.revpar !== null 
          ? currentMetrics.revpar - stlyMetrics.revpar 
          : null;
        const revparVariancePercentage = calculatePercentageChange(currentMetrics.revpar, stlyMetrics.revpar);
        const revparWowPickup = currentMetrics.revpar !== null && weekAgoMetrics.revpar !== null 
          ? currentMetrics.revpar - weekAgoMetrics.revpar 
          : null;

        return {
          month: monthStart.toISOString(),
          monthDisplay,
          metrics: {
            adr: {
              currentProjection: currentMetrics.adr,
              stlyActual: stlyMetrics.adr,
              varianceVsStly: {
                absolute: adrVariance,
                percentage: adrVariancePercentage,
              },
              wowPickup: adrWowPickup,
            },
            occupancy: {
              currentProjection: currentMetrics.occupancy,
              stlyActual: stlyMetrics.occupancy,
              varianceVsStly: {
                absolute: occupancyVariance,
                percentage: occupancyVariancePercentage,
              },
              wowPickup: occupancyWowPickup,
            },
            revpar: {
              currentProjection: currentMetrics.revpar,
              stlyActual: stlyMetrics.revpar,
              varianceVsStly: {
                absolute: revparVariance,
                percentage: revparVariancePercentage,
              },
              wowPickup: revparWowPickup,
            },
          },
        };
      }));

      return monthlyData;
    }),

  // Get weekly pacing (WoW pickup) for future months
  getWeeklyPacing: protectedProcedure
    .input(z.object({
      organizationId: z.string(),
    }))
    .output(z.array(weeklyPacingSchema))
    .query(async ({ ctx, input }) => {
      const { organizationId } = input;
      const userId = ctx.session.user.id;
      const today = new Date();
      const sevenDaysAgo = subDays(today, 7);

      // Verify user has access to this organization
      const userOrg = await ctx.db.userOrganization.findFirst({
        where: { 
          userId,
          organizationId,
        },
      });
      
      if (!userOrg) {
        throw new Error("Organization not found or access denied");
      }

      // Get active properties
      const properties = await ctx.db.property.findMany({
        where: {
          organizationId,
          isActive: true,
        },
        select: {
          id: true,
        },
      });

      const propertyIds = properties.map(p => p.id);
      const activeProperties = properties.filter(p => p !== null);

      if (activeProperties.length === 0) {
        return [];
      }

      // Get next 12 months starting from current month
      const months: Date[] = [];
      for (let i = 0; i < 12; i++) {
        months.push(startOfMonth(addMonths(today, i)));
      }

      // Process each month
      const monthlyData = await Promise.all(months.map(async (monthStart) => {
        const monthEnd = endOfMonth(monthStart);
        const monthDisplay = format(monthStart, 'MMMM yyyy');

        // Get current projections (reservations booked up to now)
        const currentReservations = await ctx.db.wheelhouseReservation.findMany({
          where: {
            propertyId: { in: propertyIds },
            bookedAt: { lte: today },
            status: { notIn: ['cancelled', 'declined'] },
            OR: [
              {
                startDate: { gte: monthStart, lte: monthEnd }
              },
              {
                endDate: { gte: monthStart, lte: monthEnd }
              },
              {
                startDate: { lt: monthStart },
                endDate: { gt: monthEnd }
              }
            ]
          },
          select: {
            startDate: true,
            endDate: true,
            totalPrice: true,
            nightlySubtotal: true,
          }
        });

        // Get projections from 7 days ago
        const weekAgoReservations = await ctx.db.wheelhouseReservation.findMany({
          where: {
            propertyId: { in: propertyIds },
            bookedAt: { lte: sevenDaysAgo },
            status: { notIn: ['cancelled', 'declined'] },
            OR: [
              {
                startDate: { gte: monthStart, lte: monthEnd }
              },
              {
                endDate: { gte: monthStart, lte: monthEnd }
              },
              {
                startDate: { lt: monthStart },
                endDate: { gt: monthEnd }
              }
            ]
          },
          select: {
            startDate: true,
            endDate: true,
            totalPrice: true,
            nightlySubtotal: true,
          }
        });

        // Calculate metrics for each dataset
        const currentMetrics = calculateMonthMetrics(currentReservations, monthStart, monthEnd, activeProperties.length);
        const weekAgoMetrics = calculateMonthMetrics(weekAgoReservations, monthStart, monthEnd, activeProperties.length);

        // Calculate WoW pickup (current - week ago)
        const adrWowPickup = currentMetrics.adr !== null && weekAgoMetrics.adr !== null 
          ? currentMetrics.adr - weekAgoMetrics.adr 
          : null;
        const occupancyWowPickup = currentMetrics.occupancy !== null && weekAgoMetrics.occupancy !== null 
          ? currentMetrics.occupancy - weekAgoMetrics.occupancy 
          : null;
        const revparWowPickup = currentMetrics.revpar !== null && weekAgoMetrics.revpar !== null 
          ? currentMetrics.revpar - weekAgoMetrics.revpar 
          : null;

        return {
          month: monthStart.toISOString(),
          monthDisplay,
          wowPickup: {
            adr: adrWowPickup,
            occupancy: occupancyWowPickup,
            revpar: revparWowPickup,
          },
        };
      }));

      return monthlyData;
    }),
});

// Helper function to calculate percentage change
function calculatePercentageChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) {
    return null;
  }
  return ((current - previous) / previous) * 100;
}

// Helper function to calculate metrics for a given set of reservations within a month
function calculateMonthMetrics(
  reservations: Array<{
    startDate: Date;
    endDate: Date;
    totalPrice: any;
    nightlySubtotal: any;
  }>,
  monthStart: Date,
  monthEnd: Date,
  propertyCount: number
) {
  let totalNights = 0;
  let totalRevenue = 0;

  // Calculate nights and revenue for each reservation
  for (const reservation of reservations) {
    const resStart = reservation.startDate;
    const resEnd = reservation.endDate;

    // Calculate overlap with the month
    const overlapStart = isAfter(resStart, monthStart) ? resStart : monthStart;
    const overlapEnd = isBefore(resEnd, monthEnd) ? resEnd : monthEnd;

    // Only process if there's actual overlap
    if (isAfter(overlapEnd, overlapStart)) {
      const nightsInMonth = differenceInDays(overlapEnd, overlapStart);
      totalNights += nightsInMonth;

      // Calculate revenue for the nights in this month
      // Use nightlySubtotal if available, otherwise use totalPrice
      if (reservation.nightlySubtotal) {
        const totalNights = differenceInDays(resEnd, resStart);
        const nightlyRate = totalNights > 0 ? Number(reservation.nightlySubtotal) / totalNights : 0;
        totalRevenue += nightlyRate * nightsInMonth;
      } else if (reservation.totalPrice) {
        // Allocate total price proportionally to nights in this month
        const totalReservationNights = differenceInDays(resEnd, resStart);
        const monthRevenue = totalReservationNights > 0 ? (Number(reservation.totalPrice) / totalReservationNights) * nightsInMonth : 0;
        totalRevenue += monthRevenue;
      }
    }
  }

  // Calculate total available nights for all properties
  const daysInMonth = differenceInDays(monthEnd, monthStart) + 1;
  const totalAvailableNights = propertyCount * daysInMonth;

  // Calculate metrics
  const occupancy = totalAvailableNights > 0 ? (totalNights / totalAvailableNights) * 100 : null;
  const adr = totalNights > 0 ? totalRevenue / totalNights : null;
  const revpar = totalAvailableNights > 0 ? totalRevenue / totalAvailableNights : null;

  return {
    adr,
    occupancy,
    revpar,
    totalNights,
    totalRevenue,
    totalAvailableNights,
  };
}
