/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable camelcase */

import { expect } from 'chai';
import { Connection, Messages } from '@salesforce/core';
import { DataRaptorMigrationTool } from '../../src/migration/dataraptor';
import { NameMappingRegistry } from '../../src/migration/NameMappingRegistry';
import { Logger } from '../../src/utils/logger';
import { initializeDataModelService } from '../../src/utils/dataModelService';
import { OmnistudioOrgDetails } from '../../src/utils/orgUtils';

/**
 * DataRaptor Custom / Managed-Package Data Model - colon->dot object-path conversion.
 *
 * Counterpart to the standard-data-model suite. On the custom data model the org is on the managed
 * package (omniStudioOrgPermissionEnabled = false), so DRMapItem records are keyed by *namespaced
 * source* field names (e.g. omnistudio__InterfaceFieldAPIName__c) rather than the standard target names.
 * These tests confirm the colon->dot conversion applies across Data Mapper types (Transform, Turbo
 * Extract, Load) on both the migration path (mapDataRaptorItemData) and the assessment path
 * (processDataMappers infos) for the custom model as well.
 *
 * The conversion is field-based and NOT gated by Type; "Turbo Extract" is an Extract with the
 * IsProcessSuperBulk flag, so it carries the same item path fields as Extract.
 */
describe('DataRaptor Custom Data Model - colon->dot object-path conversion', () => {
  const NS = 'omnistudio';
  let dataRaptorTool: DataRaptorMigrationTool;
  let mockConnection: Connection;
  let mockMessages: Messages<string>;

  beforeEach(() => {
    NameMappingRegistry.getInstance().clear();

    const mockOrgDetails: OmnistudioOrgDetails = {
      packageDetails: { version: '1.0.0', namespace: NS },
      omniStudioOrgPermissionEnabled: false, // Custom / managed-package data model
      orgDetails: { Name: 'Test Org', Id: '00D000000000000' },
      dataModel: 'Custom',
      hasValidNamespace: true,
      isFoundationPackage: false,
      isOmnistudioMetadataAPIEnabled: false,
    } as unknown as OmnistudioOrgDetails;
    initializeDataModelService(mockOrgDetails);

    mockConnection = {
      getApiVersion: () => '62.0',
    } as unknown as Connection;

    mockMessages = {
      getMessage: (key: string, params?: string[]) => {
        const messages: Record<string, string> = {
          objectPathSeparatorChange: `The Data Mapper object path '${params?.[0]}' will be updated to '${params?.[1]}' during migration to use the standard runtime's dot separator.`,
        };
        return messages[key] || 'Mock message for testing';
      },
    } as unknown as Messages<string>;

    // Constructed AFTER initializeDataModelService so IS_STANDARD_DATA_MODEL resolves to false.
    dataRaptorTool = new DataRaptorMigrationTool(NS, mockConnection, {} as Logger, mockMessages, {} as any);
  });

  // Helper: build a namespaced DRMapItem raw record (custom-model keying) from source field values.
  const item = (id: string, fields: Record<string, any>): Record<string, any> => {
    const record: Record<string, any> = { Id: id, Name: 'CustomTypeDM' };
    for (const [sourceField, value] of Object.entries(fields)) {
      record[`${NS}__${sourceField}`] = value;
    }
    return record;
  };

  const bundle = (type: string, extra: Record<string, any> = {}): Record<string, any> => ({
    Id: `dr_${type}`,
    Name: 'CustomTypeDM',
    [`${NS}__Type__c`]: type,
    ...extra,
  });

  it('converts Transform input/output node paths (migration + assessment)', async () => {
    const items = [item('tf1', { InterfaceFieldAPIName__c: 'In:acct:name', DomainObjectFieldAPIName__c: 'Out:acct' })];

    // Migration: custom-model records map to target keys, then the conversion runs on the mapped object.
    const mig = (dataRaptorTool as any).mapDataRaptorItemData(items[0], 'parent');
    expect(mig.InputFieldName).to.equal('In.acct:name'); // reference keeps field-accessor colon
    expect(mig.OutputFieldName).to.equal('Out.acct'); // node definition dots out fully

    // Assessment: detection reads the raw namespaced fields and reports the conversions as infos.
    const map = new Map();
    map.set('CustomTypeDM', items);
    const res = await (dataRaptorTool as any).processDataMappers(bundle('Transform'), new Set<string>(), map, []);
    expect(res.type).to.equal('Transform');
    expect(res.migrationStatus).to.equal('Ready for migration');
    expect(res.warnings).to.be.empty;
    expect(res.infos.some((i: string) => i.includes("'In:acct:name'") && i.includes("'In.acct:name'"))).to.be.true;
    expect(res.infos.some((i: string) => i.includes("'Out:acct'") && i.includes("'Out.acct'"))).to.be.true;
  });

  it('converts Turbo Extract (Extract + IsProcessSuperBulk) node paths (migration + assessment)', async () => {
    const items = [
      item('te1', { InterfaceObjectName__c: 'Case', DomainObjectFieldAPIName__c: 'Acc:info' }),
      item('te2', { InterfaceFieldAPIName__c: 'Acc:info:id', DomainObjectFieldAPIName__c: 'IdValue' }),
    ];

    const migNode = (dataRaptorTool as any).mapDataRaptorItemData(items[0], 'parent');
    expect(migNode.InputObjectName).to.equal('Case'); // plain SObject, untouched
    expect(migNode.OutputFieldName).to.equal('Acc.info'); // node definition dots out fully
    const migRef = (dataRaptorTool as any).mapDataRaptorItemData(items[1], 'parent');
    expect(migRef.InputFieldName).to.equal('Acc.info:id'); // reference keeps field-accessor colon

    const map = new Map();
    map.set('CustomTypeDM', items);
    // Turbo Extract = Extract with the IsProcessSuperBulk flag set; the flag does not gate conversion.
    const res = await (dataRaptorTool as any).processDataMappers(
      bundle('Extract', { [`${NS}__IsProcessSuperBulk__c`]: true }),
      new Set<string>(),
      map,
      []
    );
    expect(res.migrationStatus).to.equal('Ready for migration');
    expect(res.warnings).to.be.empty;
    expect(res.infos.some((i: string) => i.includes("'Acc:info'") && i.includes("'Acc.info'"))).to.be.true;
    expect(res.infos.some((i: string) => i.includes("'Acc:info:id'") && i.includes("'Acc.info:id'"))).to.be.true;
  });

  it('converts Load output object path and input reference (migration + assessment)', async () => {
    const items = [
      item('ld1', { DomainObjectAPIName__c: 'Acc:AccountInfo', DomainObjectFieldAPIName__c: 'Name' }),
      item('ld2', { InterfaceFieldAPIName__c: 'src:node:field', DomainObjectFieldAPIName__c: 'Value' }),
    ];

    const migObj = (dataRaptorTool as any).mapDataRaptorItemData(items[0], 'parent');
    expect(migObj.OutputObjectName).to.equal('Acc.AccountInfo'); // object path dots out fully
    expect(migObj.OutputFieldName).to.equal('Name'); // plain field, untouched
    const migRef = (dataRaptorTool as any).mapDataRaptorItemData(items[1], 'parent');
    expect(migRef.InputFieldName).to.equal('src.node:field'); // reference keeps field-accessor colon

    const map = new Map();
    map.set('CustomTypeDM', items);
    const res = await (dataRaptorTool as any).processDataMappers(bundle('Load'), new Set<string>(), map, []);
    expect(res.type).to.equal('Load');
    expect(res.migrationStatus).to.equal('Ready for migration');
    expect(res.warnings).to.be.empty;
    expect(res.infos.some((i: string) => i.includes("'Acc:AccountInfo'") && i.includes("'Acc.AccountInfo'"))).to.be
      .true;
    expect(res.infos.some((i: string) => i.includes("'src:node:field'") && i.includes("'src.node:field'"))).to.be.true;
  });

  it('reports nothing for colon-free paths regardless of type', async () => {
    const items = [
      item('cf1', {
        InterfaceObjectName__c: 'Case',
        DomainObjectFieldAPIName__c: 'Name',
        InterfaceFieldAPIName__c: 'Id',
      }),
    ];
    const map = new Map();
    map.set('CustomTypeDM', items);
    const res = await (dataRaptorTool as any).processDataMappers(bundle('Extract'), new Set<string>(), map, []);
    expect(res.infos).to.be.empty;
    expect(res.migrationStatus).to.equal('Ready for migration');
  });
});
