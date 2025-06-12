import { z } from 'zod';
import { createTRPCRouter, protectedProcedure } from '../trpc';

export const adminRouter = createTRPCRouter({
  // Ultra-simple raw SQL query - guaranteed to work
  getEveryTask: protectedProcedure.query(async ({ ctx }) => {
    // Direct SQL query bypassing all Prisma ORM complexity
    const tasks = await ctx.db.$queryRaw`
      SELECT 
        id,
        title,
        status,
        "organizationId",
        "createdAt",
        priority,
        description,
        "dueDate"
      FROM "Task" 
      WHERE "isDeleted" = false
      ORDER BY "createdAt" DESC
    `;

    return tasks;
  }),

  // Organization task summary for admin monitoring
  getOrganizationTaskSummary: protectedProcedure.query(async ({ ctx }) => {
    // Use type-safe Prisma Client query to eliminate enum mapping issues
    const organizationSummaries = await ctx.db.organization.findMany({
      select: {
        id: true,
        name: true,
        tasks: {
          where: {
            isDeleted: false,
          },
          select: {
            id: true,
            status: true,
            dueDate: true,
            updatedAt: true,
          },
        },
      },
    });

    // Transform the data to match the expected format
    const result = organizationSummaries.map((org) => {
      const totalTasks = org.tasks.length;
      const openTasks = org.tasks.filter(
        (task) => task.status === 'NOT_STARTED' || task.status === 'IN_PROGRESS'
      );
      const openTaskCount = openTasks.length;
      const overdueTaskCount = openTasks.filter(
        (task) => task.dueDate && new Date(task.dueDate) < new Date()
      ).length;
      const lastActivity = org.tasks.length > 0 
        ? org.tasks.reduce((latest, task) => 
            task.updatedAt > latest ? task.updatedAt : latest, 
            new Date(0)
          )
        : null;

      return {
        organizationId: org.id,
        organizationName: org.name,
        totalTasks: BigInt(totalTasks),
        openTaskCount: BigInt(openTaskCount),
        overdueTaskCount: BigInt(overdueTaskCount),
        lastActivity,
      };
    });

    // Sort by openTaskCount DESC, overdueTaskCount DESC, lastActivity DESC
    return result.sort((a, b) => {
      if (a.openTaskCount !== b.openTaskCount) {
        return Number(b.openTaskCount - a.openTaskCount);
      }
      if (a.overdueTaskCount !== b.overdueTaskCount) {
        return Number(b.overdueTaskCount - a.overdueTaskCount);
      }
      if (!a.lastActivity && !b.lastActivity) return 0;
      if (!a.lastActivity) return 1;
      if (!b.lastActivity) return -1;
      return b.lastActivity.getTime() - a.lastActivity.getTime();
    });
  }),

  // Get all open tasks assigned to current admin user across all organizations
  getMyOpenTasks: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    
    const tasks = await ctx.db.task.findMany({
      where: {
        isDeleted: false,
        status: {
          in: ['NOT_STARTED', 'IN_PROGRESS']
        },
        assignees: {
          some: {
            userId: userId
          }
        }
      },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
          },
        },
        assignees: {
          select: {
            user: { // Select THROUGH the join table to the 'user'
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
          },
        },
        properties: {
          select: {
            property: { // Select THROUGH the join table to the 'property'
              select: {
                id: true,
                title: true,
              },
            },
          },
        },
        buildings: {
          select: {
            building: { // Select THROUGH the join table to the 'building'
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
      orderBy: [
        { priority: 'desc' },
        { dueDate: 'asc' },
        { createdAt: 'desc' }
      ]
    });

    return tasks;
  }),

  // Get all tasks in system with optional filtering
  getAllTasks: protectedProcedure
    .input(z.object({
      organizationId: z.string().optional(),
      status: z.string().optional(),
      limit: z.number().default(50),
      offset: z.number().default(0)
    }))
    .query(async ({ ctx, input }) => {
      const where: any = {
        isDeleted: false
      };

      if (input.organizationId) {
        where.organizationId = input.organizationId;
      }

      if (input.status) {
        where.status = input.status;
      }

      const tasks = await ctx.db.task.findMany({
        where,
        include: {
          organization: {
            select: {
              id: true,
              name: true,
            },
          },
          assignees: {
            select: {
              user: { // Select THROUGH the join table to the 'user'
                select: {
                  id: true,
                  name: true,
                  email: true,
                  image: true,
                },
              },
            },
          },
          properties: {
            select: {
              property: { // Select THROUGH the join table to the 'property'
                select: {
                  id: true,
                  title: true,
                },
              },
            },
          },
          buildings: {
            select: {
              building: { // Select THROUGH the join table to the 'building'
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
        orderBy: [
          { priority: 'desc' },
          { dueDate: 'asc' },
          { createdAt: 'desc' }
        ],
        take: input.limit,
        skip: input.offset
      });

      const totalCount = await ctx.db.task.count({ where });

      return {
        tasks,
        totalCount
      };
    }),

  // Get all organizations for admin dropdown
  getAllOrganizations: protectedProcedure.query(async ({ ctx }) => {
    const organizations = await ctx.db.organization.findMany({
      select: {
        id: true,
        name: true,
      },
      orderBy: {
        name: 'asc'
      }
    });

    return organizations;
  }),
});