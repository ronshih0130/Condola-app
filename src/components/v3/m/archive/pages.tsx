import React from 'react';
import {notFound} from 'next/navigation';
import {archiveList} from '../../../../server/record-archive';
import type {Session} from '../../../../server/types';
import type {ArchiveTab} from '../../../../lib/record-archive';
import {ArchiveListView} from './views';
export async function ArchiveListPageV3({session,after,tab='all'}:{session:Session;after?:string;tab?:ArchiveTab}) {
 // Exactly the legacy reader admission. In particular, no new maintenance permission.
 const data=await archiveList(session,after,tab);
 if(data.state!=='ready'&&!data.readFailed)notFound();
 return <ArchiveListView data={data} locale={session.locale} tab={tab} admin={session.role==='admin'}/>;
}
